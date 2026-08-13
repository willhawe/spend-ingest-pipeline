package com.willhawe.spendtracker;

import android.app.Notification;
import android.content.ComponentName;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;

import java.text.NumberFormat;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class BankNotificationStore {
    private static final Pattern GBP_AMOUNT = Pattern.compile("£\\s*([0-9]+(?:,[0-9]{3})*(?:\\.[0-9]{1,2})?)");

    // A repeat of the same merchant/amount/day within this window is treated
    // as a re-posted or updated notification for the same purchase (Wallet
    // sometimes fires more than once for one tap), not a second, genuinely
    // separate purchase -- see PaymentDao#findRecentMatch. This replaced a
    // same-calendar-day dedup key that wrongly merged two real same-day,
    // same-amount purchases (e.g. two coffees) into one.
    private static final long DUPLICATE_WINDOW_MILLIS = 2 * 60 * 1000L;

    // How long a *synced* row is kept around after Supabase has confirmed it,
    // purely so there's a short window to debug "did this actually sync"
    // before it's cleaned up. Unsynced rows are never subject to this --
    // they're kept until markSynced() says otherwise, however long that takes.
    private static final long SYNCED_RETENTION_MILLIS = 3L * 24 * 60 * 60 * 1000;

    private BankNotificationStore() {}

    public static void recordNotification(Context context, StatusBarNotification sbn) {
        // Updated unconditionally, before any filtering -- this is the
        // strongest available signal that the listener is alive and actually
        // receiving system callbacks, independent of whether any given
        // notification turns out to be relevant.
        NotificationHealthStore.recordNotificationSeen(context);

        Notification notification = sbn.getNotification();
        if (notification == null || notification.extras == null) {
            NotificationHealthStore.recordOutcome(context, sbn.getPackageName(), NotificationHealthStore.OUTCOME_NO_CONTENT, null);
            return;
        }

        String appLabel = getAppLabel(context, sbn.getPackageName());
        String title = charSequenceToString(notification.extras.getCharSequence(Notification.EXTRA_TITLE));
        String text = charSequenceToString(notification.extras.getCharSequence(Notification.EXTRA_TEXT));
        String bigText = charSequenceToString(notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
        String combined = join(appLabel, title, text, bigText);

        if (!looksLikeBankNotification(sbn.getPackageName(), appLabel, combined)) {
            NotificationHealthStore.recordOutcome(context, sbn.getPackageName(), NotificationHealthStore.OUTCOME_WRONG_APP, appLabel);
            return;
        }

        String rejectionReason = classifySpend(combined);
        if (rejectionReason != null) {
            NotificationHealthStore.recordOutcome(context, sbn.getPackageName(), rejectionReason, null);
            return;
        }

        Integer amountCents = parseAmountCents(combined);
        if (amountCents == null || amountCents <= 0) {
            NotificationHealthStore.recordOutcome(context, sbn.getPackageName(), NotificationHealthStore.OUTCOME_UNPARSEABLE_AMOUNT, null);
            return;
        }

        String merchant = parseMerchant(title, combined);
        String cardSource = detectCardSource(combined);
        String paymentDate = todayKey();
        long now = System.currentTimeMillis();

        PaymentDao dao = AppDatabase.getInstance(context).paymentDao();
        PaymentEntity duplicate = dao.findRecentMatch(merchant, amountCents, paymentDate, now - DUPLICATE_WINDOW_MILLIS);
        if (duplicate != null) {
            NotificationHealthStore.recordOutcome(context, sbn.getPackageName(), NotificationHealthStore.OUTCOME_DUPLICATE, null);
            return;
        }

        PaymentEntity entity = new PaymentEntity();
        entity.id = paymentId(sbn.getKey(), paymentDate, merchant, amountCents);
        entity.merchant = merchant;
        entity.amount = formatGbp(amountCents);
        entity.amountCents = amountCents;
        entity.paymentDate = paymentDate;
        entity.source = "notification";
        entity.cardSource = cardSource;
        entity.deleted = false;
        entity.createdAt = now;

        // insert() returns -1 when OnConflictStrategy.IGNORE silently dropped
        // the row because its id (which incorporates a hash of the
        // notification's own key) already exists -- e.g. if Android/Wallet
        // ever reuses a notification key for a genuinely new purchase. That's
        // an unproven edge case, not a confirmed one, so surface it in
        // diagnostics as a duplicate rather than claiming "accepted" for a
        // row that was actually a no-op.
        long rowId = dao.insert(entity);
        if (rowId == -1) {
            NotificationHealthStore.recordOutcome(context, sbn.getPackageName(), NotificationHealthStore.OUTCOME_DUPLICATE, "id collision");
            return;
        }

        NotificationHealthStore.recordOutcome(context, sbn.getPackageName(), NotificationHealthStore.OUTCOME_ACCEPTED, merchant);
        SpentTodayWidget.updateAll(context);
    }

    public static boolean isNotificationAccessEnabled(Context context) {
        String enabled = Settings.Secure.getString(
                context.getContentResolver(),
                "enabled_notification_listeners"
        );
        if (enabled == null) return false;

        String expected = new ComponentName(context, BankNotificationListener.class).flattenToString();
        String expectedShort = new ComponentName(context, BankNotificationListener.class).flattenToShortString();
        return enabled.contains(expected) || enabled.contains(expectedShort);
    }

    public static String getSpentToday(Context context) {
        int cents = AppDatabase.getInstance(context).paymentDao().sumForDate(todayKey());
        return formatGbp(cents);
    }

    public static String getLastMerchant(Context context) {
        PaymentEntity mostRecent = AppDatabase.getInstance(context).paymentDao().getMostRecent();
        return mostRecent == null ? "" : mostRecent.merchant;
    }

    public static String getLastAmount(Context context) {
        PaymentEntity mostRecent = AppDatabase.getInstance(context).paymentDao().getMostRecent();
        return mostRecent == null ? "" : mostRecent.amount;
    }

    // Only pending (unsynced) rows -- the sole consumer of this is the JS
    // sync loop, which re-uploads (and re-marks-synced) whatever comes back.
    // Returning every row here would keep resetting synced_at to "now" on
    // every poll, so already-synced rows would never age past the retention
    // window in markSynced()/purgeSyncedBefore(), and every row ever
    // recorded would get re-uploaded to Supabase every two seconds forever.
    public static String getScannedPayments(Context context) {
        List<PaymentEntity> pending = AppDatabase.getInstance(context).paymentDao().getPending();
        JSONArray array = new JSONArray();
        for (PaymentEntity entity : pending) {
            try {
                array.put(new JSONObject()
                        .put("id", entity.id)
                        .put("merchant", entity.merchant)
                        .put("amount", entity.amount)
                        .put("amount_cents", entity.amountCents)
                        .put("payment_date", entity.paymentDate)
                        .put("source", entity.source)
                        .put("card_source", entity.cardSource == null ? JSONObject.NULL : entity.cardSource)
                        .put("category", entity.category == null ? JSONObject.NULL : entity.category)
                        .put("deleted", entity.deleted)
                        .put("deleted_at", entity.deletedAt == null ? JSONObject.NULL : entity.deletedAt));
            } catch (JSONException e) {
                // Skip a malformed row rather than failing the whole payload.
            }
        }
        return array.toString();
    }

    // Scoped to today only, matching what this has always claimed to do --
    // clearAllTables() would also wipe older pending (unsynced) rows still
    // waiting to reach Supabase, which is a different, much more destructive
    // operation than "clear today's notification data".
    public static void clearToday(Context context) {
        AppDatabase.getInstance(context).paymentDao().deleteForDate(todayKey());
        SpentTodayWidget.updateAll(context);
    }

    public static void addManualPayment(Context context, String merchant, int amountCents) {
        if (merchant == null || merchant.trim().isEmpty() || amountCents <= 0) return;

        String cleanMerchant = merchant.trim();
        String today = todayKey();
        long now = System.currentTimeMillis();

        PaymentEntity entity = new PaymentEntity();
        entity.id = "manual|" + today + "|" + slug(cleanMerchant) + "|" + amountCents + "|" + now;
        entity.merchant = cleanMerchant;
        entity.amount = formatGbp(amountCents);
        entity.amountCents = amountCents;
        entity.paymentDate = today;
        entity.source = "manual";
        entity.deleted = false;
        entity.createdAt = now;
        AppDatabase.getInstance(context).paymentDao().insert(entity);

        SpentTodayWidget.updateAll(context);
    }

    public static void deletePayment(Context context, String id) {
        if (id == null || id.trim().isEmpty()) return;
        AppDatabase.getInstance(context).paymentDao().markDeleted(id, nowIso());
        SpentTodayWidget.updateAll(context);
    }

    public static void setCategory(Context context, String id, String category) {
        if (id == null || id.trim().isEmpty()) return;
        String trimmed = category == null ? "" : category.trim();
        AppDatabase.getInstance(context).paymentDao().updateCategory(id, trimmed.isEmpty() ? null : trimmed);
    }

    // Called by the JS layer once it has confirmed Supabase accepted these
    // rows -- only then are they eligible for eventual cleanup (and even
    // then, only after SYNCED_RETENTION_MILLIS, not immediately). Anything
    // never marked synced is kept indefinitely.
    public static void markSynced(Context context, List<String> ids) {
        if (ids == null || ids.isEmpty()) return;
        long now = System.currentTimeMillis();
        PaymentDao dao = AppDatabase.getInstance(context).paymentDao();
        dao.markSynced(ids, now);
        dao.purgeSyncedBefore(now - SYNCED_RETENTION_MILLIS);
    }

    public static String getDiagnostics(Context context) {
        PaymentDao dao = AppDatabase.getInstance(context).paymentDao();
        JSONObject snapshot = NotificationHealthStore.getHealthSnapshot(context);
        try {
            snapshot.put("notificationAccessEnabled", isNotificationAccessEnabled(context));
            snapshot.put("pendingUploadCount", dao.countPending());
            PaymentEntity mostRecent = dao.getMostRecent();
            if (mostRecent != null) {
                snapshot.put("lastAcceptedMerchant", mostRecent.merchant);
                snapshot.put("lastAcceptedAmount", mostRecent.amount);
                snapshot.put("lastAcceptedAt", iso(mostRecent.createdAt));
            }
        } catch (JSONException e) {
            // best effort -- return whatever was successfully assembled
        }
        return snapshot.toString();
    }

    private static boolean looksLikeBankNotification(String packageName, String appLabel, String combined) {
        // Real Google Wallet notifications don't say "google wallet" anywhere —
        // the label is just "Wallet" and the text is e.g. "£12.90 with Chase
        // Debit Mastercard ••7614" — so match the app itself, not the text.
        String pkg = packageName == null ? "" : packageName.toLowerCase(Locale.UK);
        String label = appLabel == null ? "" : appLabel.trim().toLowerCase(Locale.UK);
        boolean walletApp = pkg.startsWith("com.google.") && pkg.contains("wallet");
        boolean walletLabel = label.equals("wallet") || label.equals("google wallet");
        boolean walletText = join(packageName, appLabel, combined).toLowerCase(Locale.UK).contains("google wallet");
        return walletApp || walletLabel || walletText;
    }

    static boolean looksLikeBankNotificationForTest(String packageName, String appLabel, String combined) {
        return looksLikeBankNotification(packageName, appLabel, combined);
    }

    // Google Wallet notification text names the card issuer directly, e.g.
    // "£12.90 with Chase Debit Mastercard ••7614" or "£12.05 with The
    // American Express® Rewards Credit Card ••2002" — pull that out so
    // transactions can be attributed to a card, not just tagged "notification".
    private static String detectCardSource(String combined) {
        String lower = combined.toLowerCase(Locale.UK);
        if (lower.contains("chase")) return "chase";
        if (lower.contains("american express") || lower.contains("amex")) return "amex";
        return null;
    }

    static String detectCardSourceForTest(String combined) {
        return detectCardSource(combined);
    }

    // Returns null when the text looks like a genuine spend notification, or
    // one of NotificationHealthStore.OUTCOME_* describing why it doesn't --
    // used both to gate recording and to explain the rejection in
    // diagnostics, instead of collapsing every non-match into one boolean.
    private static String classifySpend(String combined) {
        String lower = combined.toLowerCase(Locale.UK);
        if (!lower.contains("£")) return NotificationHealthStore.OUTCOME_NO_AMOUNT;
        if (lower.contains("refund")
                || lower.contains("refunded")
                || lower.contains("payment received")
                || lower.contains("paid your")
                || lower.contains("declined")
                || lower.contains("wasn't approved")) {
            return NotificationHealthStore.OUTCOME_REFUND_OR_DECLINED;
        }

        boolean looksLikeSpend = lower.contains("google wallet")
                || lower.contains("spent")
                || lower.contains("you paid")
                || lower.contains("purchase")
                || lower.contains("transaction")
                || lower.contains("card");
        return looksLikeSpend ? null : NotificationHealthStore.OUTCOME_NOT_RECOGNISED;
    }

    static String classifySpendForTest(String combined) {
        return classifySpend(combined);
    }

    private static Integer parseAmountCents(String text) {
        Matcher matcher = GBP_AMOUNT.matcher(text);
        if (!matcher.find()) return null;

        String raw = matcher.group(1).replace(",", "");
        String[] parts = raw.split("\\.", 2);
        int pounds = Integer.parseInt(parts[0]);
        int pence = 0;
        if (parts.length == 2) {
            String fraction = parts[1];
            if (fraction.length() == 1) fraction = fraction + "0";
            if (fraction.length() > 2) fraction = fraction.substring(0, 2);
            pence = Integer.parseInt(fraction);
        }
        return pounds * 100 + pence;
    }

    static Integer parseAmountCentsForTest(String text) {
        return parseAmountCents(text);
    }

    private static String parseMerchant(String title, String text) {
        if (title != null && !title.trim().isEmpty() && !title.contains("£")) {
            return title.trim();
        }

        String lower = text.toLowerCase(Locale.UK);
        int at = lower.indexOf(" at ");
        if (at >= 0) {
            String merchant = text.substring(at + 4).trim();
            int sentenceEnd = merchant.indexOf(".");
            if (sentenceEnd >= 0) merchant = merchant.substring(0, sentenceEnd);
            return merchant.trim();
        }
        return "";
    }

    static String parseMerchantForTest(String title, String text) {
        return parseMerchant(title, text);
    }

    private static String paymentId(String notificationKey, String paymentDate, String merchant, int amountCents) {
        String hash = Integer.toHexString(Math.abs((notificationKey == null ? "" : notificationKey).hashCode()));
        return "notif|" + paymentDate + "|" + slug(merchant) + "|" + amountCents + "|" + hash;
    }

    private static String slug(String value) {
        String lower = value == null ? "" : value.toLowerCase(Locale.UK);
        String replaced = lower.replaceAll("[^a-z0-9]+", "-").replaceAll("^-+|-+$", "");
        return replaced.length() > 48 ? replaced.substring(0, 48) : replaced;
    }

    private static String getAppLabel(Context context, String packageName) {
        try {
            PackageManager pm = context.getPackageManager();
            ApplicationInfo info = pm.getApplicationInfo(packageName, 0);
            CharSequence label = pm.getApplicationLabel(info);
            return label == null ? "" : label.toString();
        } catch (PackageManager.NameNotFoundException e) {
            return "";
        }
    }

    private static String todayKey() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.UK).format(new Date());
    }

    private static String nowIso() {
        return iso(System.currentTimeMillis());
    }

    private static String iso(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.UK);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(millis));
    }

    private static String formatGbp(int cents) {
        NumberFormat format = NumberFormat.getCurrencyInstance(Locale.UK);
        return format.format(cents / 100.0);
    }

    private static String charSequenceToString(CharSequence value) {
        return value == null ? "" : value.toString();
    }

    private static String join(String... values) {
        StringBuilder builder = new StringBuilder();
        for (String value : values) {
            if (value == null || value.trim().isEmpty()) continue;
            if (builder.length() > 0) builder.append(" ");
            builder.append(value.trim());
        }
        return builder.toString();
    }
}
