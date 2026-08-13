package com.willhawe.spendtracker;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import androidx.room.Room;
import androidx.test.core.app.ApplicationProvider;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;

import java.util.Collections;
import java.util.List;

// Exercises the Room-backed durable queue directly (bypassing
// BankNotificationStore's Context/singleton plumbing) -- this is the part of
// the storage rewrite that a plain JVM unit test can't cover, since it
// depends on real SQLite behaviour (conflict handling, WHERE clauses, etc.)
// rather than pure string/regex logic.
@RunWith(RobolectricTestRunner.class)
public class PaymentDaoTest {
    private AppDatabase database;
    private PaymentDao dao;

    @Before
    public void setUp() {
        database = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext(), AppDatabase.class)
                .allowMainThreadQueries()
                .build();
        dao = database.paymentDao();
    }

    @After
    public void tearDown() {
        database.close();
    }

    private static PaymentEntity payment(String id, String merchant, int amountCents, String date, long createdAt) {
        PaymentEntity entity = new PaymentEntity();
        entity.id = id;
        entity.merchant = merchant;
        entity.amount = "£" + (amountCents / 100.0);
        entity.amountCents = amountCents;
        entity.paymentDate = date;
        entity.source = "notification";
        entity.deleted = false;
        entity.createdAt = createdAt;
        return entity;
    }

    @Test
    public void insertingSameIdTwiceKeepsOnlyOneRowAndReportsTheConflict() {
        long firstRowId = dao.insert(payment("id-1", "Tesco", 450, "2026-08-13", 1000L));
        long secondRowId = dao.insert(payment("id-1", "Tesco", 450, "2026-08-13", 1000L));

        assertEquals(1, dao.getAll().size());
        // BankNotificationStore.recordNotification relies on this -1 to know
        // the insert was silently ignored, rather than reporting "accepted"
        // for a row that was actually a no-op.
        assertEquals(true, firstRowId != -1);
        assertEquals(-1L, secondRowId);
    }

    @Test
    public void twoSeparatePurchasesSameDaySameAmountBothPersist() {
        // The old dedup key ("today|merchant|amountCents") would have
        // silently dropped the second of these -- two coffees, same price,
        // same day, is a completely normal thing to happen.
        dao.insert(payment("coffee-1", "Pret", 350, "2026-08-13", 1_000L));
        dao.insert(payment("coffee-2", "Pret", 350, "2026-08-13", 10_000_000L));

        assertEquals(2, dao.getAll().size());
    }

    @Test
    public void findRecentMatchFindsRowWithinWindow() {
        dao.insert(payment("id-1", "Tesco", 450, "2026-08-13", 1_000L));

        PaymentEntity match = dao.findRecentMatch("Tesco", 450, "2026-08-13", 500L);
        assertNotNull(match);
        assertEquals("id-1", match.id);
    }

    @Test
    public void findRecentMatchIgnoresRowOutsideWindow() {
        dao.insert(payment("id-1", "Tesco", 450, "2026-08-13", 1_000L));

        // sinceMillis of 5000 excludes the row created at 1000.
        PaymentEntity match = dao.findRecentMatch("Tesco", 450, "2026-08-13", 5_000L);
        assertNull(match);
    }

    @Test
    public void markSyncedThenPurgeRemovesOnlyOldSyncedRows() {
        dao.insert(payment("synced-old", "Tesco", 450, "2026-08-01", 1_000L));
        dao.insert(payment("synced-new", "Tesco", 450, "2026-08-13", 2_000L));
        dao.insert(payment("unsynced", "Tesco", 450, "2026-08-13", 3_000L));

        dao.markSynced(java.util.Arrays.asList("synced-old", "synced-new"), 100_000L);
        // Purge anything synced before t=50_000 -- only "synced-old" qualifies
        // once we also backdate its synced_at below the cutoff.
        dao.markSynced(Collections.singletonList("synced-old"), 10_000L);
        dao.purgeSyncedBefore(50_000L);

        List<PaymentEntity> remaining = dao.getAll();
        assertEquals(2, remaining.size());
        for (PaymentEntity entity : remaining) {
            assertEquals(false, "synced-old".equals(entity.id));
        }
    }

    @Test
    public void unsyncedRowsSurviveAnyPurge() {
        dao.insert(payment("unsynced", "Tesco", 450, "2026-01-01", 1_000L));

        dao.purgeSyncedBefore(Long.MAX_VALUE);

        assertEquals(1, dao.getAll().size());
    }

    @Test
    public void sumForDateOnlyCountsThatDateAndExcludesDeleted() {
        dao.insert(payment("a", "Tesco", 450, "2026-08-13", 1_000L));
        dao.insert(payment("b", "Sainsburys", 550, "2026-08-13", 2_000L));
        dao.insert(payment("c", "Tesco", 999, "2026-08-12", 3_000L));
        dao.markDeleted("b", "2026-08-13T12:00:00Z");

        assertEquals(450, dao.sumForDate("2026-08-13"));
    }

    @Test
    public void countPendingExcludesDeletedAndSyncedRows() {
        dao.insert(payment("pending", "Tesco", 450, "2026-08-13", 1_000L));
        dao.insert(payment("synced", "Tesco", 550, "2026-08-13", 2_000L));
        dao.insert(payment("deleted", "Tesco", 650, "2026-08-13", 3_000L));
        dao.markSynced(Collections.singletonList("synced"), 5_000L);
        dao.markDeleted("deleted", "2026-08-13T12:00:00Z");

        assertEquals(1, dao.countPending());
    }

    @Test
    public void getMostRecentReturnsNewestNonDeletedByCreatedAt() {
        dao.insert(payment("older", "Tesco", 450, "2026-08-12", 1_000L));
        dao.insert(payment("newer", "Sainsburys", 550, "2026-08-13", 2_000L));
        dao.insert(payment("newest-but-deleted", "Aldi", 650, "2026-08-13", 3_000L));
        dao.markDeleted("newest-but-deleted", "2026-08-13T12:00:00Z");

        PaymentEntity mostRecent = dao.getMostRecent();
        assertNotNull(mostRecent);
        assertEquals("newer", mostRecent.id);
    }

    @Test
    public void getPendingExcludesAlreadySyncedRows() {
        dao.insert(payment("pending", "Tesco", 450, "2026-08-13", 1_000L));
        dao.insert(payment("synced", "Tesco", 550, "2026-08-13", 2_000L));
        dao.markSynced(Collections.singletonList("synced"), 5_000L);

        List<PaymentEntity> pending = dao.getPending();
        assertEquals(1, pending.size());
        assertEquals("pending", pending.get(0).id);
    }

    @Test
    public void getPendingIncludesUnsyncedDeletedRows() {
        // A deletion that hasn't reached Supabase yet still needs to sync --
        // getPending() must not filter these out just because deleted=true.
        dao.insert(payment("deleted-but-unsynced", "Tesco", 450, "2026-08-13", 1_000L));
        dao.markDeleted("deleted-but-unsynced", "2026-08-13T12:00:00Z");

        assertEquals(1, dao.getPending().size());
    }

    @Test
    public void markSyncedRowsDropOutOfPendingWithoutBeingRefreshedByLaterPolls() {
        // Regression test for the bug where getScannedPayments() (backed by
        // getAll()) returned every row, syncPayments() re-uploaded all of
        // them every poll, and markSynced() kept resetting synced_at to
        // "now" -- so a row already synced minutes ago would never actually
        // age past the retention window. With getPending(), a synced row
        // simply stops coming back at all, so there's nothing left to
        // refresh.
        dao.insert(payment("id-1", "Tesco", 450, "2026-08-13", 1_000L));
        dao.markSynced(Collections.singletonList("id-1"), 5_000L);

        List<PaymentEntity> pendingAfterFirstPoll = dao.getPending();
        assertEquals(0, pendingAfterFirstPoll.size());

        // Simulate the next poll tick: nothing pending means nothing gets
        // re-uploaded, so markSynced never runs again for this row, and its
        // synced_at stays at the original 5_000L instead of being refreshed.
        dao.purgeSyncedBefore(10_000L);
        assertEquals(0, dao.getAll().size());
    }

    @Test
    public void deleteForDateOnlyRemovesThatDate() {
        dao.insert(payment("today-1", "Tesco", 450, "2026-08-13", 1_000L));
        dao.insert(payment("today-2", "Sainsburys", 550, "2026-08-13", 2_000L));
        dao.insert(payment("yesterday", "Aldi", 650, "2026-08-12", 3_000L));

        dao.deleteForDate("2026-08-13");

        List<PaymentEntity> remaining = dao.getAll();
        assertEquals(1, remaining.size());
        assertEquals("yesterday", remaining.get(0).id);
    }

    @Test
    public void deleteForDateAlsoRemovesUnsyncedRowsForThatDate() {
        // clearToday() is meant to nuke today's local cache outright,
        // including anything not yet synced -- unlike purgeSyncedBefore(),
        // which must never touch unsynced rows.
        dao.insert(payment("today-unsynced", "Tesco", 450, "2026-08-13", 1_000L));

        dao.deleteForDate("2026-08-13");

        assertEquals(0, dao.getAll().size());
    }
}
