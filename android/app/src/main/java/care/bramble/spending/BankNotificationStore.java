package care.bramble.spending;

import android.app.Notification;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.provider.Settings;
import android.service.notification.StatusBarNotification;

import java.text.NumberFormat;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class BankNotificationStore {
    private static final String PREFS = "SpendingWidget";
    private static final String KEY_SPENT_TODAY = "spent_today";
    private static final String KEY_SPENT_TODAY_CENTS = "spent_today_cents";
    private static final String KEY_NOTIFICATION_DATE = "notification_date";
    private static final String KEY_SEEN_NOTIFICATIONS = "seen_notifications";
    private static final String KEY_SEEN_PAYMENTS = "seen_payments";
    private static final String KEY_SCANNED_PAYMENTS = "scanned_payments";
    private static final String KEY_LAST_NOTIFICATION = "last_bank_notification";
    private static final String KEY_LAST_MERCHANT = "last_bank_merchant";
    private static final String KEY_LAST_AMOUNT = "last_bank_amount";

    private static final Pattern GBP_AMOUNT = Pattern.compile("£\\s*([0-9]+(?:,[0-9]{3})*(?:\\.[0-9]{1,2})?)");

    private BankNotificationStore() {}

    public static void recordNotification(Context context, StatusBarNotification sbn) {
        Notification notification = sbn.getNotification();
        if (notification == null || notification.extras == null) return;

        String appLabel = getAppLabel(context, sbn.getPackageName());
        String title = charSequenceToString(notification.extras.getCharSequence(Notification.EXTRA_TITLE));
        String text = charSequenceToString(notification.extras.getCharSequence(Notification.EXTRA_TEXT));
        String bigText = charSequenceToString(notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
        String combined = join(appLabel, title, text, bigText);

        if (!looksLikeBankNotification(sbn.getPackageName(), appLabel, combined)) return;
        if (!looksLikeSpend(combined)) return;

        Integer amountCents = parseAmountCents(combined);
        if (amountCents == null || amountCents <= 0) return;
        String merchant = parseMerchant(title, combined);
        String cardSource = detectCardSource(combined);

        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String today = todayKey();
        resetIfNewDay(prefs, today);

        Set<String> seen = new HashSet<>(prefs.getStringSet(KEY_SEEN_NOTIFICATIONS, new HashSet<>()));
        Set<String> seenPayments = new HashSet<>(prefs.getStringSet(KEY_SEEN_PAYMENTS, new HashSet<>()));
        String notificationKey = sbn.getKey();
        String paymentKey = paymentKey(today, merchant, amountCents);
        if (seen.contains(notificationKey) || seenPayments.contains(paymentKey)) return;
        seen.add(notificationKey);
        seenPayments.add(paymentKey);

        int currentCents = prefs.getInt(KEY_SPENT_TODAY_CENTS, 0);
        int updatedCents = currentCents + amountCents;
        String amount = formatGbp(updatedCents);

        prefs.edit()
                .putString(KEY_NOTIFICATION_DATE, today)
                .putStringSet(KEY_SEEN_NOTIFICATIONS, seen)
                .putStringSet(KEY_SEEN_PAYMENTS, seenPayments)
                .putInt(KEY_SPENT_TODAY_CENTS, updatedCents)
                .putString(KEY_SPENT_TODAY, amount)
                .putString(KEY_LAST_NOTIFICATION, combined)
                .putString(KEY_LAST_MERCHANT, merchant)
                .putString(KEY_LAST_AMOUNT, formatGbp(amountCents))
                .putString(KEY_SCANNED_PAYMENTS, appendPayment(
                        prefs.getString(KEY_SCANNED_PAYMENTS, "[]"),
                        merchant,
                        formatGbp(amountCents),
                        amountCents,
                        today,
                        paymentKey,
                        "notification",
                        cardSource))
                .apply();

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
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        resetIfNewDay(prefs, todayKey());
        return prefs.getString(KEY_SPENT_TODAY, "£0.00");
    }

    public static String getLastMerchant(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        resetIfNewDay(prefs, todayKey());
        return prefs.getString(KEY_LAST_MERCHANT, "");
    }

    public static String getLastAmount(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        resetIfNewDay(prefs, todayKey());
        return prefs.getString(KEY_LAST_AMOUNT, "");
    }

    public static String getScannedPayments(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        resetIfNewDay(prefs, todayKey());
        return prefs.getString(KEY_SCANNED_PAYMENTS, "[]");
    }

    public static void clearToday(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        prefs.edit()
                .putString(KEY_NOTIFICATION_DATE, todayKey())
                .putInt(KEY_SPENT_TODAY_CENTS, 0)
                .putString(KEY_SPENT_TODAY, "£0.00")
                .putStringSet(KEY_SEEN_NOTIFICATIONS, new HashSet<>())
                .putStringSet(KEY_SEEN_PAYMENTS, new HashSet<>())
                .putString(KEY_SCANNED_PAYMENTS, "[]")
                .putString(KEY_LAST_NOTIFICATION, "")
                .putString(KEY_LAST_MERCHANT, "")
                .putString(KEY_LAST_AMOUNT, "")
                .apply();
        SpentTodayWidget.updateAll(context);
    }

    public static void addManualPayment(Context context, String merchant, int amountCents) {
        if (merchant == null || merchant.trim().isEmpty() || amountCents <= 0) return;

        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String today = todayKey();
        resetIfNewDay(prefs, today);

        String cleanMerchant = merchant.trim();
        String id = "manual|" + today + "|" + cleanMerchant.toLowerCase(Locale.UK) + "|" + amountCents + "|" + System.currentTimeMillis();
        int updatedCents = prefs.getInt(KEY_SPENT_TODAY_CENTS, 0) + amountCents;

        prefs.edit()
                .putString(KEY_NOTIFICATION_DATE, today)
                .putInt(KEY_SPENT_TODAY_CENTS, updatedCents)
                .putString(KEY_SPENT_TODAY, formatGbp(updatedCents))
                .putString(KEY_LAST_NOTIFICATION, "")
                .putString(KEY_LAST_MERCHANT, cleanMerchant)
                .putString(KEY_LAST_AMOUNT, formatGbp(amountCents))
                .putString(KEY_SCANNED_PAYMENTS, appendPayment(
                        prefs.getString(KEY_SCANNED_PAYMENTS, "[]"),
                        cleanMerchant,
                        formatGbp(amountCents),
                        amountCents,
                        today,
                        id,
                        "manual",
                        null))
                .apply();

        SpentTodayWidget.updateAll(context);
    }

    public static void deletePayment(Context context, String id) {
        if (id == null || id.trim().isEmpty()) return;

        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        resetIfNewDay(prefs, todayKey());

        try {
            JSONArray payments = new JSONArray(prefs.getString(KEY_SCANNED_PAYMENTS, "[]"));
            JSONArray next = new JSONArray();
            String latestMerchant = "";
            String latestAmount = "";
            int totalCents = 0;

            for (int i = 0; i < payments.length(); i += 1) {
                JSONObject payment = payments.getJSONObject(i);
                if (id.equals(payment.optString("id"))) {
                    payment.put("deleted", true);
                    payment.put("deleted_at", nowIso());
                }
                next.put(payment);

                if (!payment.optBoolean("deleted", false)) {
                    totalCents += payment.optInt("amount_cents", 0);
                    if (latestMerchant.isEmpty()) {
                        latestMerchant = payment.optString("merchant", "");
                        latestAmount = payment.optString("amount", "");
                    }
                }
            }

            prefs.edit()
                    .putInt(KEY_SPENT_TODAY_CENTS, totalCents)
                    .putString(KEY_SPENT_TODAY, formatGbp(totalCents))
                    .putString(KEY_LAST_MERCHANT, latestMerchant)
                    .putString(KEY_LAST_AMOUNT, latestAmount)
                    .putString(KEY_SCANNED_PAYMENTS, next.toString())
                    .apply();

            SpentTodayWidget.updateAll(context);
        } catch (JSONException e) {
            // Leave existing data untouched if the local JSON is unexpectedly malformed.
        }
    }

    public static void setCategory(Context context, String id, String category) {
        if (id == null || id.trim().isEmpty()) return;

        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        resetIfNewDay(prefs, todayKey());

        try {
            JSONArray payments = new JSONArray(prefs.getString(KEY_SCANNED_PAYMENTS, "[]"));
            for (int i = 0; i < payments.length(); i += 1) {
                JSONObject payment = payments.getJSONObject(i);
                if (id.equals(payment.optString("id"))) {
                    String trimmed = category == null ? "" : category.trim();
                    payment.put("category", trimmed.isEmpty() ? JSONObject.NULL : trimmed);
                    break;
                }
            }
            prefs.edit().putString(KEY_SCANNED_PAYMENTS, payments.toString()).apply();
        } catch (JSONException e) {
            // Leave existing data untouched if the local JSON is unexpectedly malformed.
        }
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

    private static boolean looksLikeSpend(String combined) {
        String lower = combined.toLowerCase(Locale.UK);
        if (!lower.contains("£")) return false;
        if (lower.contains("refund")
                || lower.contains("refunded")
                || lower.contains("payment received")
                || lower.contains("paid your")
                || lower.contains("declined")
                || lower.contains("wasn't approved")) {
            return false;
        }

        return lower.contains("google wallet")
                || lower.contains("spent")
                || lower.contains("you paid")
                || lower.contains("purchase")
                || lower.contains("transaction")
                || lower.contains("card");
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

    private static void resetIfNewDay(SharedPreferences prefs, String today) {
        String storedDay = prefs.getString(KEY_NOTIFICATION_DATE, "");
        if (today.equals(storedDay)) return;
        prefs.edit()
                .putString(KEY_NOTIFICATION_DATE, today)
                .putInt(KEY_SPENT_TODAY_CENTS, 0)
                .putString(KEY_SPENT_TODAY, "£0.00")
                .putStringSet(KEY_SEEN_NOTIFICATIONS, new HashSet<>())
                .putStringSet(KEY_SEEN_PAYMENTS, new HashSet<>())
                .putString(KEY_SCANNED_PAYMENTS, "[]")
                .putString(KEY_LAST_NOTIFICATION, "")
                .putString(KEY_LAST_MERCHANT, "")
                .putString(KEY_LAST_AMOUNT, "")
                .apply();
    }

    private static String paymentKey(String today, String merchant, int amountCents) {
        return today + "|" + merchant.trim().toLowerCase(Locale.UK) + "|" + amountCents;
    }

    private static String appendPayment(
            String rawPayments,
            String merchant,
            String amount,
            int amountCents,
            String paymentDate,
            String id,
            String source,
            String cardSource
    ) {
        try {
            JSONArray payments = new JSONArray(rawPayments == null ? "[]" : rawPayments);
            JSONObject payment = new JSONObject()
                    .put("id", id)
                    .put("merchant", merchant)
                    .put("amount", amount)
                    .put("amount_cents", amountCents)
                    .put("payment_date", paymentDate)
                    .put("source", source)
                    .put("card_source", cardSource == null ? JSONObject.NULL : cardSource)
                    .put("category", JSONObject.NULL)
                    .put("deleted", false);
            JSONArray next = new JSONArray();
            next.put(payment);
            for (int i = 0; i < payments.length() && i < 19; i += 1) {
                next.put(payments.get(i));
            }
            return next.toString();
        } catch (JSONException e) {
            return "[]";
        }
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
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.UK);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date());
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
