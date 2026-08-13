package com.willhawe.spendtracker;

import android.content.Context;

import androidx.room.Database;
import androidx.room.Room;
import androidx.room.RoomDatabase;

@Database(entities = {PaymentEntity.class}, version = 1, exportSchema = false)
public abstract class AppDatabase extends RoomDatabase {
    private static volatile AppDatabase instance;

    public abstract PaymentDao paymentDao();

    public static AppDatabase getInstance(Context context) {
        if (instance == null) {
            synchronized (AppDatabase.class) {
                if (instance == null) {
                    instance = Room.databaseBuilder(
                                    context.getApplicationContext(),
                                    AppDatabase.class,
                                    "spend-tracker.db"
                            )
                            // This is called from a background notification-listener
                            // callback and from quick Capacitor plugin methods, never
                            // from a UI render loop, and the table is tiny (a personal
                            // finance app's transaction volume) with only indexed
                            // point-lookups -- so synchronous main-thread queries are a
                            // reasonable simplification here rather than introducing
                            // executors/futures, and match the rest of this codebase's
                            // synchronous SharedPreferences-based style.
                            .allowMainThreadQueries()
                            .fallbackToDestructiveMigration()
                            .build();
                }
            }
        }
        return instance;
    }
}
