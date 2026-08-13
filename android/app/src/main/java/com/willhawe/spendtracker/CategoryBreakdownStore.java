package com.willhawe.spendtracker;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public final class CategoryBreakdownStore {
    private static final String PREFS = "SpendingWidget";
    private static final String KEY_CATEGORY_BREAKDOWN = "category_breakdown_json";
    public static final int DEFAULT_COLOR = Color.parseColor("#8B9CB3");

    private CategoryBreakdownStore() {}

    public static final class SubEntry {
        public final String name;
        public final int color;
        public final int amountCents;

        public SubEntry(String name, int color, int amountCents) {
            this.name = name;
            this.color = color;
            this.amountCents = amountCents;
        }
    }

    public static final class Entry {
        public final String category;
        public final int color;
        public final int amountCents;
        public final List<SubEntry> subcategories;

        public Entry(String category, int color, int amountCents, List<SubEntry> subcategories) {
            this.category = category;
            this.color = color;
            this.amountCents = amountCents;
            this.subcategories = subcategories;
        }
    }

    public static void save(Context context, JSONArray categories) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_CATEGORY_BREAKDOWN, categories.toString())
                .apply();
    }

    private static int parseColor(String raw) {
        try {
            return Color.parseColor(raw);
        } catch (IllegalArgumentException | NullPointerException ignored) {
            return DEFAULT_COLOR;
        }
    }

    public static List<Entry> load(Context context) {
        String raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(KEY_CATEGORY_BREAKDOWN, "[]");
        List<Entry> entries = new ArrayList<>();
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i += 1) {
                JSONObject item = array.getJSONObject(i);
                String category = item.optString("category", "Other");
                int amountCents = item.optInt("amountCents", 0);
                if (amountCents <= 0) continue;

                int color = parseColor(item.optString("color", null));
                List<SubEntry> subcategories = new ArrayList<>();
                JSONArray subArray = item.optJSONArray("subcategories");
                if (subArray != null) {
                    for (int j = 0; j < subArray.length(); j += 1) {
                        JSONObject subItem = subArray.optJSONObject(j);
                        if (subItem == null) continue;
                        int subAmount = subItem.optInt("amountCents", 0);
                        if (subAmount <= 0) continue;
                        subcategories.add(new SubEntry(
                                subItem.optString("name", null),
                                parseColor(subItem.optString("color", null)),
                                subAmount));
                    }
                }

                entries.add(new Entry(category, color, amountCents, subcategories));
            }
        } catch (JSONException ignored) {
            // Fall back to an empty breakdown if the stored JSON is unexpectedly malformed.
        }
        return entries;
    }
}
