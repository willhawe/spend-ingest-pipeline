package com.willhawe.spendtracker;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class BankNotificationStoreTest {

    @Test
    public void parsesGoogleWalletAmexNotification() {
        String title = "LONDON NORTH EASTERN RAILWAY";
        String text = "£12.05 with The American Express® Rewards Credit Card ••2002";

        assertEquals(Integer.valueOf(1205), BankNotificationStore.parseAmountCentsForTest(text));
        assertEquals(title, BankNotificationStore.parseMerchantForTest(title, text));
    }

    @Test
    public void matchesGoogleWalletByPackageName() {
        assertTrue(BankNotificationStore.looksLikeBankNotificationForTest(
                "com.google.android.apps.walletnfcrel",
                "Wallet",
                "Wallet The Whiskey Jar £12.90 with Chase Debit Mastercard ••7614"));
    }

    @Test
    public void ignoresDirectChaseAppNotification() {
        assertFalse(BankNotificationStore.looksLikeBankNotificationForTest(
                "com.chase.intl",
                "Chase",
                "Chase You paid £12.90 at The Whiskey Jar with your Chase card"));
    }

    @Test
    public void ignoresDirectAmexAppNotification() {
        assertFalse(BankNotificationStore.looksLikeBankNotificationForTest(
                "com.americanexpress.android.acctsvcs.uk",
                "Amex",
                "American Express You spent £12.05 at LNER"));
    }

    @Test
    public void detectsChaseCardSource() {
        assertEquals("chase", BankNotificationStore.detectCardSourceForTest(
                "Wallet The Whiskey Jar £12.90 with Chase Debit Mastercard ••7614"));
    }

    @Test
    public void detectsAmexCardSource() {
        assertEquals("amex", BankNotificationStore.detectCardSourceForTest(
                "£12.05 with The American Express® Rewards Credit Card ••2002"));
    }

    @Test
    public void detectsNoCardSourceForUnrecognisedCard() {
        assertEquals(null, BankNotificationStore.detectCardSourceForTest(
                "£12.90 with Monzo Debit Mastercard ••1234"));
    }

    @Test
    public void classifiesGenuineSpendAsAccepted() {
        assertEquals(null, BankNotificationStore.classifySpendForTest(
                "Wallet The Whiskey Jar £12.90 with Chase Debit Mastercard ••7614"));
    }

    @Test
    public void classifiesMissingAmountSymbol() {
        assertEquals(NotificationHealthStore.OUTCOME_NO_AMOUNT, BankNotificationStore.classifySpendForTest(
                "Wallet The Whiskey Jar with Chase Debit Mastercard ••7614"));
    }

    @Test
    public void classifiesRefundAsRejected() {
        assertEquals(NotificationHealthStore.OUTCOME_REFUND_OR_DECLINED, BankNotificationStore.classifySpendForTest(
                "£12.90 refunded to your Chase Debit Mastercard ••7614"));
    }

    @Test
    public void classifiesDeclinedAsRejected() {
        assertEquals(NotificationHealthStore.OUTCOME_REFUND_OR_DECLINED, BankNotificationStore.classifySpendForTest(
                "£12.90 payment declined on your Chase Debit Mastercard ••7614"));
    }

    @Test
    public void classifiesUnrecognisedTextWithAmount() {
        assertEquals(NotificationHealthStore.OUTCOME_NOT_RECOGNISED, BankNotificationStore.classifySpendForTest(
                "Your balance is now £12.90"));
    }
}
