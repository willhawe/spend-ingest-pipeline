import { createClient } from "@supabase/supabase-js";
import { markPaymentsSynced, type ScannedPayment } from "./plugins/WidgetBridge";
import { inferCategory } from "./categories";
import { formatGbp, slug, type ParsedRow, type StatementSource } from "./importPayments";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;
const supabaseProjectRef = supabaseUrl?.match(/^https:\/\/([^.]+)\.supabase\.co/)?.[1];
const supabaseTransactionsTableId = import.meta.env.VITE_SUPABASE_TRANSACTIONS_TABLE_ID as string | undefined;

export const supabase =
  supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey)
    : null;

export type SyncStatus = "not-configured" | "synced" | "error";

export function isSupabaseConfigured(): boolean {
  return supabase !== null;
}

export function getSupabaseRowUrl(id: string): string | null {
  if (!supabaseProjectRef) return null;

  if (supabaseTransactionsTableId) {
    const filter = encodeURIComponent(`id:eq:${id}`);
    return `https://supabase.com/dashboard/project/${supabaseProjectRef}/editor/${supabaseTransactionsTableId}?schema=public&filter=${filter}`;
  }

  const escaped = id.replace(/'/g, "''");
  const query = `select * from public.transactions where id = '${escaped}';`;
  return `https://supabase.com/dashboard/project/${supabaseProjectRef}/sql/new?content=${encodeURIComponent(query)}`;
}

export async function syncPayments(payments: ScannedPayment[]): Promise<SyncStatus> {
  if (!supabase) return "not-configured";
  if (payments.length === 0) return "synced";

  // subcategory (like photo_url/receipt_image below it) is intentionally left
  // out of this upsert: `payments` here comes from the native today-cache,
  // which never carries a subcategory, so including it would null out any
  // subcategory a user just picked on the very next poll tick. Supabase is
  // the sole source of truth for subcategory — see getPaymentsForPeriod.
  const rows = payments.map((payment) => ({
    id: payment.id,
    merchant: payment.merchant,
    amount_cents: payment.amountCents,
    amount_display: payment.amount,
    payment_date: payment.paymentDate,
    source: payment.source,
    card_source: payment.cardSource,
    category: payment.category,
    deleted: payment.deleted,
    deleted_at: payment.deletedAt,
    updated_at: new Date().toISOString(),
  }));

  const { error } = await supabase
    .from("transactions")
    .upsert(rows, { onConflict: "id" });

  if (!error) {
    await markPaymentsSynced(payments.map((payment) => payment.id));
  }

  return error ? "error" : "synced";
}

export interface SubcategoryTotal {
  subcategory: string;
  amountCents: number;
}

export interface CategoryTotal {
  category: string;
  amountCents: number;
  subcategories: SubcategoryTotal[];
}

export type CategoryRange = "month" | "year";

export function periodBounds(range: CategoryRange, ref: Date): { start: Date; end: Date } {
  if (range === "year") {
    const start = new Date(ref.getFullYear(), 0, 1);
    const end = new Date(ref.getFullYear() + 1, 0, 1);
    return { start, end };
  }
  const start = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 1);
  return { start, end };
}

export interface PeriodPaymentsResult {
  payments: ScannedPayment[];
  totals: CategoryTotal[];
  totalCents: number;
  orphanedIds: string[];
}

// periodBounds() returns local calendar-day boundaries (e.g. 1 Aug 00:00
// local). Formatting those via toISOString() would convert to UTC first, so
// in any UTC+ timezone (e.g. British Summer Time) local midnight rolls back
// to the previous day's date — an August query would start from "2026-07-31"
// instead of "2026-08-01", pulling the last day of July into the August
// list. payment_date is a plain calendar date with no timezone of its own,
// so format using local Y/M/D components instead of going through UTC.
function toLocalDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function getPaymentsForPeriod(
  range: CategoryRange,
  referenceDate: Date,
): Promise<PeriodPaymentsResult> {
  if (!supabase) return { payments: [], totals: [], totalCents: 0, orphanedIds: [] };

  const { start, end } = periodBounds(range, referenceDate);
  const startStr = toLocalDateStr(start);
  const endStr = toLocalDateStr(end);

  const [transactionsResult, statementResult] = await Promise.all([
    supabase
      .from("transactions")
      .select(
        "id, merchant, amount_display, amount_cents, payment_date, source, card_source, category, subcategory, deleted, deleted_at, photo_url",
      )
      .eq("deleted", false)
      .gte("payment_date", startStr)
      .lt("payment_date", endStr)
      .order("created_at", { ascending: false }),
    supabase
      .from("statement_transactions")
      .select("matched_transaction_id")
      .gte("transaction_date", startStr)
      .lt("transaction_date", endStr),
  ]);

  const { data, error } = transactionsResult;
  if (error || !data) return { payments: [], totals: [], totalCents: 0, orphanedIds: [] };

  const payments: ScannedPayment[] = data.map((row) => ({
    id: row.id,
    merchant: row.merchant ?? "",
    amount: row.amount_display ?? formatGbpCents(row.amount_cents ?? 0),
    amountCents: row.amount_cents ?? 0,
    paymentDate: row.payment_date ?? "",
    source: row.source ?? "notification",
    cardSource: typeof row.card_source === "string" && row.card_source.trim() ? row.card_source : null,
    category: typeof row.category === "string" && row.category.trim() ? row.category : null,
    subcategory: typeof row.subcategory === "string" && row.subcategory.trim() ? row.subcategory : null,
    deleted: row.deleted === true,
    deletedAt: row.deleted_at ?? null,
    photoUrl: typeof row.photo_url === "string" && row.photo_url ? row.photo_url : null,
  }));

  const totals = new Map<string, { amountCents: number; subcategories: Map<string, number> }>();
  let totalCents = 0;
  for (const payment of payments) {
    const category = payment.category ?? inferCategory(payment.merchant);
    const bucket = totals.get(category) ?? { amountCents: 0, subcategories: new Map<string, number>() };
    bucket.amountCents += payment.amountCents;
    if (payment.subcategory) {
      bucket.subcategories.set(payment.subcategory, (bucket.subcategories.get(payment.subcategory) ?? 0) + payment.amountCents);
    }
    totals.set(category, bucket);
    totalCents += payment.amountCents;
  }

  // A statement covering this period has been uploaded if any statement row
  // falls within it — only then is it meaningful to flag notification
  // payments in the same period that no statement row matched.
  const hasStatementCoverage = !statementResult.error && (statementResult.data?.length ?? 0) > 0;
  const matchedIds = new Set(
    (statementResult.data ?? [])
      .map((row) => row.matched_transaction_id)
      .filter((id): id is string => typeof id === "string"),
  );
  const orphanedIds = hasStatementCoverage
    ? payments.filter((payment) => payment.source === "notification" && !matchedIds.has(payment.id)).map((p) => p.id)
    : [];

  return {
    payments,
    totals: [...totals.entries()]
      .map(([category, bucket]) => ({
        category,
        amountCents: bucket.amountCents,
        subcategories: [...bucket.subcategories.entries()]
          .map(([subcategory, amountCents]) => ({ subcategory, amountCents }))
          .sort((a, b) => b.amountCents - a.amountCents),
      }))
      .sort((a, b) => b.amountCents - a.amountCents),
    totalCents,
    orphanedIds,
  };
}

// Lighter-weight than getPaymentsForPeriod — used only for the "vs last
// month/year" comparison badge, which needs just a sum, not the full row
// set, breakdowns, and statement-matching for that prior period.
export async function getPeriodTotalCents(range: CategoryRange, referenceDate: Date): Promise<number> {
  if (!supabase) return 0;

  const { start, end } = periodBounds(range, referenceDate);
  const { data, error } = await supabase
    .from("transactions")
    .select("amount_cents")
    .eq("deleted", false)
    .gte("payment_date", toLocalDateStr(start))
    .lt("payment_date", toLocalDateStr(end));

  if (error || !data) return 0;
  return data.reduce((total, row) => total + (row.amount_cents ?? 0), 0);
}

function formatGbpCents(cents: number): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" }).format(cents / 100);
}

export async function getMonthlyCategoryTotals(): Promise<CategoryTotal[]> {
  const { totals } = await getPaymentsForPeriod("month", new Date());
  return totals;
}

export interface StatementTransaction {
  id: string;
  source: StatementSource;
  merchant: string;
  amount: string;
  amountCents: number;
  transactionDate: string;
  fileName: string | null;
  matchedTransactionId: string | null;
}

export interface ImportStatementResult {
  inserted: number;
  matched: number;
  unmatched: number;
}

function daysBetween(a: string, b: string): number {
  const diffMs = new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime();
  return Math.abs(Math.round(diffMs / 86_400_000));
}

async function findMatchCandidate(
  row: ParsedRow,
  alreadyLinkedIds: Set<string>,
): Promise<string | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("transactions")
    .select("id")
    .eq("deleted", false)
    .eq("amount_cents", row.amountCents)
    .eq("payment_date", row.paymentDate);

  if (error || !data) return null;

  // Auto-link only when there's exactly one same-day, same-amount
  // transaction. Zero means no counterpart was captured (e.g. no
  // notification fired for it); more than one is ambiguous — which of two
  // same-day, same-amount transactions this statement row corresponds to
  // can't be told apart, so leave both for manual linking instead of
  // guessing wrong.
  const candidates = data.filter((candidate) => !alreadyLinkedIds.has(candidate.id));
  return candidates.length === 1 ? (candidates[0]?.id ?? null) : null;
}

export async function importStatementTransactions(
  rows: ParsedRow[],
  source: StatementSource,
  fileName: string,
): Promise<ImportStatementResult> {
  if (!supabase || rows.length === 0) return { inserted: 0, matched: 0, unmatched: 0 };

  const { data: alreadyLinked } = await supabase
    .from("statement_transactions")
    .select("matched_transaction_id")
    .not("matched_transaction_id", "is", null);
  const linkedIds = new Set(
    (alreadyLinked ?? [])
      .map((r) => r.matched_transaction_id)
      .filter((id): id is string => typeof id === "string"),
  );

  let matched = 0;
  const insertRows = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;

    const matchId = await findMatchCandidate(row, linkedIds);
    if (matchId) {
      linkedIds.add(matchId);
      matched += 1;
    }

    insertRows.push({
      id: `stmt|${source}|${row.paymentDate}|${slug(row.merchant)}|${row.amountCents}|${slug(fileName)}|${index}`,
      source,
      merchant: row.merchant,
      amount_cents: row.amountCents,
      amount_display: formatGbp(row.amountCents),
      transaction_date: row.paymentDate,
      file_name: fileName,
      matched_transaction_id: matchId,
    });
  }

  const { error } = await supabase.from("statement_transactions").upsert(insertRows, { onConflict: "id" });
  if (error) return { inserted: 0, matched: 0, unmatched: 0 };

  return { inserted: insertRows.length, matched, unmatched: insertRows.length - matched };
}

export async function getUnmatchedStatementRows(): Promise<StatementTransaction[]> {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from("statement_transactions")
    .select("id, source, merchant, amount_cents, amount_display, transaction_date, file_name, matched_transaction_id")
    .is("matched_transaction_id", null)
    .order("transaction_date", { ascending: false });

  if (error || !data) return [];

  return data.map((row) => ({
    id: row.id,
    source: (row.source ?? "csv") as StatementSource,
    merchant: row.merchant ?? "",
    amount: row.amount_display ?? formatGbpCents(row.amount_cents ?? 0),
    amountCents: row.amount_cents ?? 0,
    transactionDate: row.transaction_date ?? "",
    fileName: row.file_name ?? null,
    matchedTransactionId: row.matched_transaction_id ?? null,
  }));
}

export async function getOrphanTransactionCandidates(statementRow: StatementTransaction): Promise<ScannedPayment[]> {
  if (!supabase) return [];

  const [linkedResult, transactionsResult] = await Promise.all([
    supabase.from("statement_transactions").select("matched_transaction_id").not("matched_transaction_id", "is", null),
    supabase
      .from("transactions")
      .select("id, merchant, amount_display, amount_cents, payment_date, source, category, deleted, deleted_at")
      .eq("deleted", false)
      .eq("source", "notification"),
  ]);

  if (transactionsResult.error || !transactionsResult.data) return [];

  const linkedIds = new Set(
    (linkedResult.data ?? [])
      .map((row) => row.matched_transaction_id)
      .filter((id): id is string => typeof id === "string"),
  );

  return transactionsResult.data
    .filter((row) => !linkedIds.has(row.id))
    .map((row) => ({
      id: row.id,
      merchant: row.merchant ?? "",
      amount: row.amount_display ?? formatGbpCents(row.amount_cents ?? 0),
      amountCents: row.amount_cents ?? 0,
      paymentDate: row.payment_date ?? "",
      source: row.source ?? "notification",
      category: typeof row.category === "string" && row.category.trim() ? row.category : null,
      deleted: row.deleted === true,
      deletedAt: row.deleted_at ?? null,
    }))
    .sort(
      (a, b) =>
        daysBetween(a.paymentDate, statementRow.transactionDate) -
        daysBetween(b.paymentDate, statementRow.transactionDate),
    )
    .slice(0, 25);
}

export async function linkStatementTransaction(statementId: string, transactionId: string): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase
    .from("statement_transactions")
    .update({ matched_transaction_id: transactionId })
    .eq("id", statementId);
  return !error;
}

export interface ReceiptItem {
  id: number;
  name: string;
  priceCents: number;
}

export interface TransactionBreakdown {
  receiptImage: string | null;
  photoUrl: string | null;
  items: ReceiptItem[];
}

export async function getTransactionBreakdown(id: string): Promise<TransactionBreakdown | null> {
  if (!supabase) return null;

  const [transactionResult, itemsResult] = await Promise.all([
    supabase.from("transactions").select("receipt_image, photo_url").eq("id", id).maybeSingle(),
    supabase
      .from("transaction_items")
      .select("id, name, price_cents")
      .eq("transaction_id", id)
      .order("created_at"),
  ]);

  if (transactionResult.error) return null;

  return {
    receiptImage:
      typeof transactionResult.data?.receipt_image === "string" ? transactionResult.data.receipt_image : null,
    photoUrl: typeof transactionResult.data?.photo_url === "string" ? transactionResult.data.photo_url : null,
    items: parseItems(itemsResult.data),
  };
}

export async function updatePaymentCategory(
  id: string,
  category: string,
  options?: { clearSubcategory?: boolean },
): Promise<boolean> {
  if (!supabase) return false;
  const trimmed = category.trim();
  const update: Record<string, unknown> = {
    category: trimmed.length > 0 ? trimmed : null,
    updated_at: new Date().toISOString(),
  };
  // Sub-categories are scoped to their parent category, so moving a
  // transaction to a different category invalidates whatever sub-category it
  // had (e.g. "Takeaway" under Food is meaningless once moved to Transport).
  if (options?.clearSubcategory) update.subcategory = null;
  const { error } = await supabase.from("transactions").update(update).eq("id", id);
  return !error;
}

export async function updatePaymentSubcategory(id: string, subcategory: string): Promise<boolean> {
  if (!supabase) return false;
  const trimmed = subcategory.trim();
  const { error } = await supabase
    .from("transactions")
    .update({ subcategory: trimmed.length > 0 ? trimmed : null, updated_at: new Date().toISOString() })
    .eq("id", id);
  return !error;
}

export async function saveReceiptImage(id: string, image: string): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase.from("transactions").update({ receipt_image: image }).eq("id", id);
  return !error;
}

export async function getOtherPaymentsFromMerchant(
  merchant: string,
  excludeId: string,
  excludeCategory: string,
): Promise<ScannedPayment[]> {
  if (!supabase || !merchant.trim()) return [];

  // ilike with escaped pattern chars = case-insensitive exact match.
  const pattern = merchant.replace(/[\\%_]/g, (char) => `\\${char}`);
  const { data, error } = await supabase
    .from("transactions")
    .select("id, merchant, amount_display, amount_cents, payment_date, source, category, deleted, deleted_at")
    .eq("deleted", false)
    .ilike("merchant", pattern)
    .neq("id", excludeId)
    .order("payment_date", { ascending: false });

  if (error || !data) return [];

  return data
    .map((row) => ({
      id: row.id,
      merchant: row.merchant ?? "",
      amount: row.amount_display ?? formatGbpCents(row.amount_cents ?? 0),
      amountCents: row.amount_cents ?? 0,
      paymentDate: row.payment_date ?? "",
      source: row.source ?? "notification",
      category: typeof row.category === "string" && row.category.trim() ? row.category : null,
      deleted: row.deleted === true,
      deletedAt: row.deleted_at ?? null,
    }))
    .filter((payment) => (payment.category ?? "") !== excludeCategory);
}

export async function setCategoryForIds(ids: string[], category: string): Promise<boolean> {
  if (!supabase || ids.length === 0) return false;
  const trimmed = category.trim();
  // Bulk-apply only ever targets transactions whose category is changing
  // (callers pre-filter out ones already matching), so any sub-category they
  // had is always stale for the new category — clear it unconditionally.
  const { error } = await supabase
    .from("transactions")
    .update({
      category: trimmed.length > 0 ? trimmed : null,
      subcategory: null,
      updated_at: new Date().toISOString(),
    })
    .in("id", ids);
  return !error;
}

export async function markPaymentDeleted(id: string): Promise<boolean> {
  if (!supabase) return false;
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("transactions")
    .update({ deleted: true, deleted_at: now, updated_at: now })
    .eq("id", id);
  return !error;
}

export async function savePhoto(id: string, url: string): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase.from("transactions").update({ photo_url: url }).eq("id", id);
  return !error;
}

const RECEIPTS_BUCKET = "receipts";
const MOMENTS_BUCKET = "moments";

export interface UploadResult {
  url: string | null;
  error: string | null;
}

async function uploadPhotoToBucket(bucket: string, transactionId: string, dataUrl: string): Promise<UploadResult> {
  if (!supabase) return { url: null, error: "Supabase is not configured in this build." };

  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/);
  const contentType = match?.[1] ?? "image/jpeg";
  const extension = contentType.split("/")[1] ?? "jpg";
  // Transaction ids contain characters storage keys reject (notification
  // ids look like "2026-07-24|merchant name|1205"), so slug the folder.
  const folder = slug(transactionId) || "txn";
  const path = `${folder}/${Date.now()}.${extension}`;

  let blob: Blob;
  try {
    blob = await (await fetch(dataUrl)).blob();
  } catch (error) {
    return { url: null, error: error instanceof Error ? error.message : "Could not read photo data." };
  }

  const { error } = await supabase.storage.from(bucket).upload(path, blob, {
    contentType,
    upsert: true,
  });
  if (error) return { url: null, error: error.message };

  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  if (!data.publicUrl) return { url: null, error: "Could not resolve public URL." };
  return { url: data.publicUrl, error: null };
}

export async function uploadReceiptPhoto(transactionId: string, dataUrl: string): Promise<UploadResult> {
  return uploadPhotoToBucket(RECEIPTS_BUCKET, transactionId, dataUrl);
}

export async function uploadMomentPhoto(transactionId: string, dataUrl: string): Promise<UploadResult> {
  return uploadPhotoToBucket(MOMENTS_BUCKET, transactionId, dataUrl);
}

export async function addReceiptItem(
  transactionId: string,
  name: string,
  priceCents: number,
): Promise<ReceiptItem | null> {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from("transaction_items")
    .insert({ transaction_id: transactionId, name, price_cents: priceCents })
    .select("id, name, price_cents")
    .single();

  if (error || !data) return null;
  return { id: data.id, name: data.name, priceCents: data.price_cents };
}

export async function removeReceiptItem(itemId: number): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase.from("transaction_items").delete().eq("id", itemId);
  return !error;
}

// Recurring monthly budget, stored as a single row (see the `budget`
// migration) — one number that applies to every month until the user
// changes it, not a per-month history.
export async function getMonthlyBudgetCents(): Promise<number> {
  if (!supabase) return 0;
  const { data, error } = await supabase.from("budget").select("monthly_budget_cents").eq("id", true).maybeSingle();
  if (error || !data) return 0;
  return typeof data.monthly_budget_cents === "number" ? data.monthly_budget_cents : 0;
}

export async function setMonthlyBudgetCents(amountCents: number): Promise<boolean> {
  if (!supabase) return false;
  const { error } = await supabase
    .from("budget")
    .upsert({ id: true, monthly_budget_cents: amountCents, updated_at: new Date().toISOString() }, { onConflict: "id" });
  return !error;
}

function parseItems(raw: unknown): ReceiptItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((row) => ({
      id: typeof row?.id === "number" ? row.id : Number(row?.id),
      name: typeof row?.name === "string" ? row.name : "",
      priceCents: typeof row?.price_cents === "number" ? row.price_cents : 0,
    }))
    .filter((item) => Number.isFinite(item.id) && item.name && item.priceCents > 0);
}
