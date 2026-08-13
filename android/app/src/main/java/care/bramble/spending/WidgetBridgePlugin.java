package care.bramble.spending;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {

    @PluginMethod
    public void setSpentToday(PluginCall call) {
        String amount = call.getString("amount", "£0.00");
        Context ctx = getContext();
        if (BankNotificationStore.isNotificationAccessEnabled(ctx)) {
            call.resolve();
            return;
        }
        SharedPreferences prefs = ctx.getSharedPreferences("SpendingWidget", Context.MODE_PRIVATE);
        prefs.edit().putString("spent_today", amount).apply();
        SpentTodayWidget.updateAll(ctx);
        call.resolve();
    }

    @PluginMethod
    public void openNotificationAccessSettings(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Android activity is not available");
            return;
        }

        ComponentName componentName = new ComponentName(activity, BankNotificationListener.class);
        Intent detailIntent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, componentName.flattenToString());
        Intent listIntent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);

        try {
            activity.startActivity(detailIntent);
            call.resolve();
        } catch (ActivityNotFoundException detailError) {
            try {
                activity.startActivity(listIntent);
                call.resolve();
            } catch (ActivityNotFoundException listError) {
                call.reject("Android notification access settings could not be opened");
            }
        }
    }

    @PluginMethod
    public void getNotificationAccessStatus(PluginCall call) {
        call.resolve(new com.getcapacitor.JSObject()
                .put("enabled", BankNotificationStore.isNotificationAccessEnabled(getContext())));
    }

    @PluginMethod
    public void getNotificationSummary(PluginCall call) {
        Context ctx = getContext();
        call.resolve(new com.getcapacitor.JSObject()
                .put("spentToday", BankNotificationStore.getSpentToday(ctx))
                .put("lastMerchant", BankNotificationStore.getLastMerchant(ctx))
                .put("lastAmount", BankNotificationStore.getLastAmount(ctx))
                .put("paymentsJson", BankNotificationStore.getScannedPayments(ctx)));
    }

    @PluginMethod
    public void clearNotificationData(PluginCall call) {
        BankNotificationStore.clearToday(getContext());
        call.resolve();
    }

    @PluginMethod
    public void addManualPayment(PluginCall call) {
        String merchant = call.getString("merchant", "");
        Integer amountCents = call.getInt("amountCents");
        if (amountCents == null || amountCents <= 0 || merchant.trim().isEmpty()) {
            call.reject("Merchant and amount are required");
            return;
        }

        BankNotificationStore.addManualPayment(getContext(), merchant, amountCents);
        call.resolve();
    }

    @PluginMethod
    public void deletePayment(PluginCall call) {
        String id = call.getString("id", "");
        if (id.trim().isEmpty()) {
            call.reject("Payment id is required");
            return;
        }

        BankNotificationStore.deletePayment(getContext(), id);
        call.resolve();
    }

    @PluginMethod
    public void setCategoryBreakdown(PluginCall call) {
        JSArray categories = call.getArray("categories");
        if (categories == null) {
            call.reject("categories is required");
            return;
        }

        try {
            org.json.JSONArray stored = new org.json.JSONArray();
            for (int i = 0; i < categories.length(); i += 1) {
                JSONObject item = categories.getJSONObject(i);
                JSONObject entry = new JSONObject();
                entry.put("category", item.optString("category", "Other"));
                entry.put("color", item.optString("color", "#8B9CB3"));
                entry.put("amountCents", item.optInt("amountCents", 0));

                org.json.JSONArray subcategories = new org.json.JSONArray();
                org.json.JSONArray sourceSubcategories = item.optJSONArray("subcategories");
                if (sourceSubcategories != null) {
                    for (int j = 0; j < sourceSubcategories.length(); j += 1) {
                        JSONObject subItem = sourceSubcategories.optJSONObject(j);
                        if (subItem == null) continue;
                        JSONObject subEntry = new JSONObject();
                        subEntry.put("name", subItem.opt("name"));
                        subEntry.put("color", subItem.optString("color", "#8B9CB3"));
                        subEntry.put("amountCents", subItem.optInt("amountCents", 0));
                        subcategories.put(subEntry);
                    }
                }
                entry.put("subcategories", subcategories);

                stored.put(entry);
            }
            CategoryBreakdownStore.save(getContext(), stored);
            MonthlyCategoryWidget.updateAll(getContext());
            call.resolve();
        } catch (JSONException e) {
            call.reject("Invalid categories payload");
        }
    }

    @PluginMethod
    public void setPaymentCategory(PluginCall call) {
        String id = call.getString("id", "");
        String category = call.getString("category", "");
        if (id.trim().isEmpty()) {
            call.reject("Payment id is required");
            return;
        }

        BankNotificationStore.setCategory(getContext(), id, category);
        call.resolve();
    }

    @PluginMethod
    public void markSynced(PluginCall call) {
        JSArray idsArray = call.getArray("ids");
        if (idsArray == null) {
            call.reject("ids is required");
            return;
        }

        try {
            List<String> ids = new ArrayList<>();
            for (int i = 0; i < idsArray.length(); i += 1) {
                ids.add(idsArray.getString(i));
            }
            BankNotificationStore.markSynced(getContext(), ids);
            call.resolve();
        } catch (JSONException e) {
            call.reject("Invalid ids payload");
        }
    }

    @PluginMethod
    public void getDiagnostics(PluginCall call) {
        try {
            JSONObject diagnostics = new JSONObject(BankNotificationStore.getDiagnostics(getContext()));
            call.resolve(com.getcapacitor.JSObject.fromJSONObject(diagnostics));
        } catch (JSONException e) {
            call.reject("Could not read diagnostics");
        }
    }
}
