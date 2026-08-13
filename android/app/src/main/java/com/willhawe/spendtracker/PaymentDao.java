package com.willhawe.spendtracker;

import androidx.annotation.Nullable;
import androidx.room.Dao;
import androidx.room.Insert;
import androidx.room.OnConflictStrategy;
import androidx.room.Query;

import java.util.List;

@Dao
public interface PaymentDao {

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    long insert(PaymentEntity entity);

    @Query("SELECT * FROM payments ORDER BY created_at DESC")
    List<PaymentEntity> getAll();

    // What the JS layer actually needs to sync: rows Supabase hasn't
    // confirmed yet. Deleted-but-unsynced rows are included deliberately --
    // the deletion itself still needs to reach Supabase. Using getAll() here
    // instead would mean re-uploading (and re-marking-synced) every row on
    // every poll, which both wastes writes and, worse, keeps resetting
    // synced_at to "now" so purgeSyncedBefore() never finds anything to purge.
    @Query("SELECT * FROM payments WHERE synced_at IS NULL ORDER BY created_at DESC")
    List<PaymentEntity> getPending();

    // Logical-duplicate guard: the same merchant/amount/day within a short
    // window of "just now" is almost certainly a re-posted or updated
    // notification for the same purchase, not a second coincidentally
    // identical one -- see recordNotification's duplicate check.
    @Nullable
    @Query(
        "SELECT * FROM payments WHERE merchant = :merchant AND amount_cents = :amountCents "
            + "AND payment_date = :date AND created_at >= :sinceMillis LIMIT 1"
    )
    PaymentEntity findRecentMatch(String merchant, int amountCents, String date, long sinceMillis);

    @Query("UPDATE payments SET category = :category WHERE id = :id")
    void updateCategory(String id, @Nullable String category);

    @Query("UPDATE payments SET deleted = 1, deleted_at = :deletedAt WHERE id = :id")
    void markDeleted(String id, String deletedAt);

    @Query("UPDATE payments SET synced_at = :syncedAtMillis WHERE id IN (:ids)")
    void markSynced(List<String> ids, long syncedAtMillis);

    @Query("SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE payment_date = :date AND deleted = 0")
    int sumForDate(String date);

    @Nullable
    @Query("SELECT * FROM payments WHERE deleted = 0 ORDER BY created_at DESC LIMIT 1")
    PaymentEntity getMostRecent();

    @Query("SELECT COUNT(*) FROM payments WHERE synced_at IS NULL AND deleted = 0")
    int countPending();

    // Grace-period cleanup: once Supabase has confirmed a row, there's no
    // reason to keep it on-device indefinitely, but a short buffer (rather
    // than deleting the instant markSynced runs) leaves room to debug a
    // "did this actually sync" question without the table growing forever.
    @Query("DELETE FROM payments WHERE synced_at IS NOT NULL AND synced_at < :beforeMillis")
    void purgeSyncedBefore(long beforeMillis);

    @Query("DELETE FROM payments WHERE payment_date = :date")
    void deleteForDate(String date);
}
