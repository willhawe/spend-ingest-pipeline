package com.willhawe.spendtracker;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

public class SpentTodayWidget extends AppWidgetProvider {

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            updateWidget(context, appWidgetManager, appWidgetId);
        }
    }

    public static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, SpentTodayWidget.class));
        for (int id : ids) {
            updateWidget(context, manager, id);
        }
    }

    public static void updateWidget(Context context, AppWidgetManager manager, int widgetId) {
        String amount = BankNotificationStore.getSpentToday(context);

        Intent intent = new Intent(context, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
                context, 0, intent, PendingIntent.FLAG_IMMUTABLE);

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_spent_today);
        views.setTextViewText(R.id.widget_amount, amount);
        views.setOnClickPendingIntent(R.id.widget_root, pendingIntent);

        manager.updateAppWidget(widgetId, views);
    }
}
