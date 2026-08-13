package com.willhawe.spendtracker;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.room.ColumnInfo;
import androidx.room.Entity;
import androidx.room.PrimaryKey;

// A captured payment, persisted until Supabase confirms it (synced_at set) --
// see PaymentDao and BankNotificationStore for the durable-queue behaviour
// this replaces (the old model kept a SharedPreferences JSON blob capped at
// 20 items and wiped everything at midnight regardless of sync state).
@Entity(tableName = "payments")
public class PaymentEntity {
    @PrimaryKey
    @NonNull
    public String id = "";

    public String merchant = "";
    public String amount = "";

    @ColumnInfo(name = "amount_cents")
    public int amountCents;

    @ColumnInfo(name = "payment_date")
    public String paymentDate = "";

    public String source = "";

    @ColumnInfo(name = "card_source")
    @Nullable
    public String cardSource;

    @Nullable
    public String category;

    public boolean deleted;

    @ColumnInfo(name = "deleted_at")
    @Nullable
    public String deletedAt;

    // Epoch millis this row was first inserted -- drives both display order
    // and the duplicate-notification detection window (see
    // PaymentDao#findRecentMatch), replacing the old "same calendar day"
    // dedup key that silently merged two genuinely separate same-day,
    // same-amount purchases into one.
    @ColumnInfo(name = "created_at")
    public long createdAt;

    // Null until the JS layer confirms Supabase accepted this row (see
    // WidgetBridgePlugin#markSynced). Unsynced rows are never purged
    // regardless of age; synced rows are only kept for a short grace period
    // (see PaymentDao#purgeSyncedBefore) so the table doesn't grow forever.
    @ColumnInfo(name = "synced_at")
    @Nullable
    public Long syncedAt;
}
