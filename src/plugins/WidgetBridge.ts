import { Capacitor, registerPlugin } from "@capacitor/core";

export interface CategoryBreakdownSegment {
  name: string | null;
  color: string;
  amountCents: number;
}

export interface CategoryBreakdownPayload {
  category: string;
  color: string;
  amountCents: number;
  subcategories: CategoryBreakdownSegment[];
}

export interface WidgetBridgePlugin {
  setSpentToday(options: { amount: string }): Promise<void>;
  setCategoryBreakdown(options: { categories: CategoryBreakdownPayload[] }): Promise<void>;
  openNotificationAccessSettings(): Promise<void>;
  getNotificationAccessStatus(): Promise<{ enabled: boolean }>;
  getNotificationSummary(): Promise<NativeNotificationSummary>;
  clearNotificationData(): Promise<void>;
  addManualPayment(options: { merchant: string; amountCents: number }): Promise<void>;
  deletePayment(options: { id: string }): Promise<void>;
  setPaymentCategory(options: { id: string; category: string }): Promise<void>;
}

const WidgetBridge = registerPlugin<WidgetBridgePlugin>("WidgetBridge");

export interface ScannedPayment {
  id: string;
  merchant: string;
  amount: string;
  amountCents: number;
  paymentDate: string;
  source: string;
  // The card issuer (e.g. "chase", "amex") parsed from a Google Wallet
  // notification's text, when the notification listener could tell. Null
  // for manual entries and for notifications it couldn't attribute.
  cardSource?: string | null;
  category: string | null;
  deleted: boolean;
  deletedAt: string | null;
  // Only populated on payments read back from Supabase; the native store
  // and file imports never carry a photo.
  photoUrl?: string | null;
  // Supabase-only, like photoUrl above — never round-tripped through the
  // native today-cache (see the comment in supabase.ts's syncPayments),
  // since that cache would otherwise clobber it back to null on every poll.
  subcategory?: string | null;
}

export interface NotificationSummary {
  spentToday: string;
  lastMerchant: string;
  lastAmount: string;
  payments: ScannedPayment[];
}

interface NativeNotificationSummary {
  spentToday: string;
  lastMerchant: string;
  lastAmount: string;
  paymentsJson?: string;
}

export async function syncWidgetTotal(amount: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await WidgetBridge.setSpentToday({ amount });
  } catch {
    // widget sync is best-effort
  }
}

export async function syncCategoryBreakdown(categories: CategoryBreakdownPayload[]): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await WidgetBridge.setCategoryBreakdown({ categories });
  } catch {
    // widget sync is best-effort
  }
}

export function canUseNotificationAccess(): boolean {
  return (
    Capacitor.isNativePlatform() &&
    Capacitor.isPluginAvailable("WidgetBridge")
  );
}

export async function openNotificationAccessSettings(): Promise<void> {
  if (!canUseNotificationAccess()) {
    throw new Error("Native notification bridge is not available");
  }
  await WidgetBridge.openNotificationAccessSettings();
}

export async function getNotificationAccessEnabled(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    const status = await WidgetBridge.getNotificationAccessStatus();
    return status.enabled;
  } catch {
    return false;
  }
}

export async function getNotificationSummary(): Promise<NotificationSummary> {
  if (!Capacitor.isNativePlatform()) {
    return { spentToday: "£0.00", lastMerchant: "", lastAmount: "", payments: [] };
  }
  try {
    const summary = await WidgetBridge.getNotificationSummary();
    return {
      spentToday: summary.spentToday,
      lastMerchant: summary.lastMerchant,
      lastAmount: summary.lastAmount,
      payments: parsePayments(summary.paymentsJson),
    };
  } catch {
    return { spentToday: "£0.00", lastMerchant: "", lastAmount: "", payments: [] };
  }
}

export async function clearNotificationData(): Promise<void> {
  if (!canUseNotificationAccess()) return;
  await WidgetBridge.clearNotificationData();
}

export async function addManualPayment(merchant: string, amountCents: number): Promise<void> {
  if (!canUseNotificationAccess()) {
    throw new Error("Native payment store is not available");
  }
  await WidgetBridge.addManualPayment({ merchant, amountCents });
}

export async function deletePayment(id: string): Promise<void> {
  if (!canUseNotificationAccess()) {
    throw new Error("Native payment store is not available");
  }
  await WidgetBridge.deletePayment({ id });
}

export async function setPaymentCategory(id: string, category: string): Promise<void> {
  if (!canUseNotificationAccess()) {
    throw new Error("Native payment store is not available");
  }
  await WidgetBridge.setPaymentCategory({ id, category });
}

function parsePayments(raw: string | undefined): ScannedPayment[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        id: typeof item?.id === "string" ? item.id : "",
        merchant: typeof item?.merchant === "string" ? item.merchant : "",
        amount: typeof item?.amount === "string" ? item.amount : "",
        amountCents: typeof item?.amount_cents === "number" ? item.amount_cents : 0,
        paymentDate: typeof item?.payment_date === "string" ? item.payment_date : "",
        source: typeof item?.source === "string" ? item.source : "notification",
        cardSource: typeof item?.card_source === "string" ? item.card_source : null,
        category: typeof item?.category === "string" && item.category.trim() ? item.category : null,
        deleted: item?.deleted === true,
        deletedAt: typeof item?.deleted_at === "string" ? item.deleted_at : null,
      }))
      .filter((item) => item.id && item.merchant && item.amount && item.amountCents > 0 && item.paymentDate);
  } catch {
    return [];
  }
}
