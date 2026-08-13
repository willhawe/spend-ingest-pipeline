package care.bramble.spending;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

// Observability for the notification listener itself -- separate from
// PaymentEntity/AppDatabase (the actual financial data), since this is
// debug-only state. A bounded rolling log here (unlike the payments queue)
// is the right trade-off: it only needs to survive long enough to answer
// "why didn't a transaction show up", not forever.
public final class NotificationHealthStore {
    private static final String PREFS = "NotificationHealth";
    private static final String KEY_LISTENER_CONNECTED = "listener_connected";
    private static final String KEY_LISTENER_CONNECTED_AT = "listener_connected_at";
    private static final String KEY_LISTENER_DISCONNECTED_AT = "listener_disconnected_at";
    private static final String KEY_LAST_NOTIFICATION_AT = "last_notification_at";
    private static final String KEY_DIAGNOSTICS = "diagnostics_log";
    private static final int MAX_DIAGNOSTICS = 50;

    public static final String OUTCOME_ACCEPTED = "accepted";
    public static final String OUTCOME_WRONG_APP = "wrong_app";
    public static final String OUTCOME_NO_CONTENT = "no_content";
    public static final String OUTCOME_NO_AMOUNT = "no_amount";
    public static final String OUTCOME_REFUND_OR_DECLINED = "refund_or_declined";
    public static final String OUTCOME_NOT_RECOGNISED = "not_recognised_as_spend";
    public static final String OUTCOME_UNPARSEABLE_AMOUNT = "unparseable_amount";
    public static final String OUTCOME_DUPLICATE = "duplicate";

    private NotificationHealthStore() {}

    public static void recordListenerConnected(Context context) {
        prefs(context).edit()
                .putBoolean(KEY_LISTENER_CONNECTED, true)
                .putLong(KEY_LISTENER_CONNECTED_AT, System.currentTimeMillis())
                .apply();
    }

    public static void recordListenerDisconnected(Context context) {
        prefs(context).edit()
                .putBoolean(KEY_LISTENER_CONNECTED, false)
                .putLong(KEY_LISTENER_DISCONNECTED_AT, System.currentTimeMillis())
                .apply();
    }

    public static void recordNotificationSeen(Context context) {
        prefs(context).edit().putLong(KEY_LAST_NOTIFICATION_AT, System.currentTimeMillis()).apply();
    }

    // detail is a short, non-sensitive label (e.g. a package name) -- never
    // the notification's own text, so this log doesn't become a second copy
    // of someone's purchase history sitting around indefinitely.
    public static void recordOutcome(Context context, String packageName, String outcome, String detail) {
        SharedPreferences prefs = prefs(context);
        try {
            JSONArray log = new JSONArray(prefs.getString(KEY_DIAGNOSTICS, "[]"));
            JSONObject entry = new JSONObject()
                    .put("at", isoNow())
                    .put("package", packageName == null ? "" : packageName)
                    .put("outcome", outcome)
                    .put("detail", detail == null ? JSONObject.NULL : detail);

            JSONArray next = new JSONArray();
            next.put(entry);
            for (int i = 0; i < log.length() && i < MAX_DIAGNOSTICS - 1; i += 1) {
                next.put(log.get(i));
            }
            prefs.edit().putString(KEY_DIAGNOSTICS, next.toString()).apply();
        } catch (JSONException e) {
            // Leave the existing log untouched if it's unexpectedly malformed.
        }
    }

    public static JSONObject getHealthSnapshot(Context context) {
        SharedPreferences prefs = prefs(context);
        JSONObject snapshot = new JSONObject();
        try {
            snapshot.put("listenerConnected", prefs.getBoolean(KEY_LISTENER_CONNECTED, false));
            snapshot.put("listenerConnectedAt", isoOrNull(prefs.getLong(KEY_LISTENER_CONNECTED_AT, 0)));
            snapshot.put("listenerDisconnectedAt", isoOrNull(prefs.getLong(KEY_LISTENER_DISCONNECTED_AT, 0)));
            snapshot.put("lastNotificationAt", isoOrNull(prefs.getLong(KEY_LAST_NOTIFICATION_AT, 0)));
            snapshot.put("diagnostics", new JSONArray(prefs.getString(KEY_DIAGNOSTICS, "[]")));
        } catch (JSONException e) {
            // best effort -- return whatever was successfully assembled
        }
        return snapshot;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static Object isoOrNull(long millis) throws JSONException {
        return millis <= 0 ? JSONObject.NULL : iso(millis);
    }

    private static String isoNow() {
        return iso(System.currentTimeMillis());
    }

    private static String iso(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.UK);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(millis));
    }
}
