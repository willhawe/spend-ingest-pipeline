import { Fragment, useEffect, useState, type CSSProperties } from "react";
import { Settings, ChevronDown, ChevronRight, TrendingDown, TrendingUp } from "lucide-react";
import { parseStatementFile } from "./importPayments";
import {
  addManualPayment,
  canUseNotificationAccess,
  deletePayment,
  getNativeDiagnostics,
  getNotificationSummary,
  openNotificationAccessSettings,
  setPaymentCategory,
  syncCategoryBreakdown,
  type NativeDiagnostics,
  type ScannedPayment,
} from "./plugins/WidgetBridge";
import {
  syncPayments,
  getSupabaseRowUrl,
  isSupabaseConfigured,
  getTransactionBreakdown,
  getMonthlyCategoryTotals,
  getPaymentsForPeriod,
  getPeriodTotalCents,
  updatePaymentCategory,
  updatePaymentSubcategory,
  getOtherPaymentsFromMerchant,
  setCategoryForIds,
  markPaymentDeleted,
  saveReceiptImage,
  uploadReceiptPhoto,
  savePhoto,
  uploadMomentPhoto,
  addReceiptItem,
  removeReceiptItem,
  importStatementTransactions,
  getUnmatchedStatementRows,
  getOrphanTransactionCandidates,
  linkStatementTransaction,
  getMonthlyBudgetCents,
  setMonthlyBudgetCents,
  type SyncStatus,
  type TransactionBreakdown,
  type CategoryRange,
  type CategoryTotal,
  type StatementTransaction,
  type ReceiptItem,
} from "./supabase";
import { captureReceiptPhoto } from "./receipt";
import { extractReceiptItems } from "./ocr";
import { inferCategory, buildBarSegments } from "./categories";
import {
  getCategories,
  createCategory,
  renameCategory,
  renameSubcategory,
  deleteCategory,
  deleteSubcategory,
  type CategoryDef,
} from "./categoriesApi";

export default function App() {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>("not-configured");
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("");
  const [formMessage, setFormMessage] = useState("");
  const [importMessage, setImportMessage] = useState("");
  const [openPaymentMenuId, setOpenPaymentMenuId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manageCategoriesOpen, setManageCategoriesOpen] = useState(false);
  const [deletePrompt, setDeletePrompt] = useState<
    | { kind: "category"; category: CategoryDef }
    | { kind: "subcategory"; category: CategoryDef; subName: string }
    | null
  >(null);
  const [breakdowns, setBreakdowns] = useState<Record<string, TransactionBreakdown>>({});
  const [scanBusyId, setScanBusyId] = useState<string | null>(null);
  const [momentBusyId, setMomentBusyId] = useState<string | null>(null);
  const [momentMessage, setMomentMessage] = useState("");
  const [itemDraftName, setItemDraftName] = useState("");
  const [itemDraftPrice, setItemDraftPrice] = useState("");
  const [breakdownMessage, setBreakdownMessage] = useState("");
  const [categories, setCategories] = useState<CategoryDef[]>([]);
  const [categoryDraft, setCategoryDraft] = useState("");
  const [subcategoryDraft, setSubcategoryDraft] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [collapseDaily, setCollapseDaily] = useState(false);
  const [periodRange, setPeriodRange] = useState<CategoryRange>("month");
  const [periodDate, setPeriodDate] = useState(() => new Date());
  const [periodPayments, setPeriodPayments] = useState<ScannedPayment[]>([]);
  const [periodTotals, setPeriodTotals] = useState<CategoryTotal[]>([]);
  const [periodTotalCents, setPeriodTotalCents] = useState(0);
  const [previousPeriodTotalCents, setPreviousPeriodTotalCents] = useState<number | null>(null);
  const [orphanedIds, setOrphanedIds] = useState<Set<string>>(new Set());
  const [unmatchedStatementRows, setUnmatchedStatementRows] = useState<StatementTransaction[]>([]);
  const [linkingStatementId, setLinkingStatementId] = useState<string | null>(null);
  const [linkCandidates, setLinkCandidates] = useState<ScannedPayment[]>([]);
  const [linkMessage, setLinkMessage] = useState("");
  const [bulkPrompt, setBulkPrompt] = useState<{
    merchant: string;
    category: string;
    payments: ScannedPayment[];
  } | null>(null);
  const [bulkMessage, setBulkMessage] = useState("");
  const [monthlyBudgetCents, setMonthlyBudgetCentsState] = useState(0);
  const [budgetDraft, setBudgetDraft] = useState("");
  const [budgetMessage, setBudgetMessage] = useState("");
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState<NativeDiagnostics | null>(null);

  const categoryColorMap = new Map(categories.map((item) => [item.name.toLowerCase(), item.color]));
  const sortedCategories = [...categories].sort((a, b) => (a.name === "Other" ? 1 : b.name === "Other" ? -1 : 0));
  const sortedCategoryNames = sortedCategories.map((item) => item.name);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      const next = await getNotificationSummary();
      if (cancelled) return;
      setSyncStatus(await syncPayments(next.payments));
      await syncMonthlyCategoryWidget();
      await loadPeriodData();
      await loadUnmatchedStatementRows();
    }

    void refresh();
    const id = window.setInterval(() => void refresh(), 2000);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [periodRange, periodDate]);

  useEffect(() => {
    document.body.style.overflow = openPaymentMenuId ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [openPaymentMenuId]);

  useEffect(() => {
    async function initCategories() {
      if (!isSupabaseConfigured()) return;
      let list = await getCategories();

      // One-time bridge for categories created before this feature existed
      // (previously stored only in this browser's localStorage). Relies on
      // createCategory's case-insensitive dedupe rather than a "ran once
      // ever" flag, so it self-heals if Supabase wasn't configured yet the
      // first time this ran.
      const existingNames = new Set(list.map((item) => item.name.toLowerCase()));
      for (const legacyName of loadLegacyCustomCategoryNames()) {
        if (existingNames.has(legacyName.toLowerCase())) continue;
        const created = await createCategory(legacyName, list.length);
        if (created) {
          list = [...list, created];
          existingNames.add(created.name.toLowerCase());
        }
      }

      setCategories(list);
    }

    void initCategories();
  }, []);

  useEffect(() => {
    async function initBudget() {
      if (!isSupabaseConfigured()) return;
      const cents = await getMonthlyBudgetCents();
      setMonthlyBudgetCentsState(cents);
      setBudgetDraft(cents > 0 ? (cents / 100).toString() : "");
    }

    void initBudget();
  }, []);

  async function syncMonthlyCategoryWidget() {
    const totals = await getMonthlyCategoryTotals();
    const payload = totals.map((item) => {
      const color = categoryColorMap.get(item.category.toLowerCase()) ?? "#8b9cb3";
      return {
        category: item.category,
        color,
        amountCents: item.amountCents,
        subcategories: buildBarSegments(item, color).map((segment) => ({
          name: segment.label,
          color: segment.color,
          amountCents: segment.amountCents,
        })),
      };
    });
    await syncCategoryBreakdown(payload);
  }

  async function loadPeriodData() {
    const result = await getPaymentsForPeriod(periodRange, periodDate);
    setPeriodPayments(result.payments);
    setPeriodTotals(result.totals);
    setPeriodTotalCents(result.totalCents);
    setOrphanedIds(new Set(result.orphanedIds));
    setPreviousPeriodTotalCents(await getPeriodTotalCents(periodRange, previousPeriodDate(periodRange, periodDate)));
  }

  async function loadUnmatchedStatementRows() {
    setUnmatchedStatementRows(await getUnmatchedStatementRows());
  }

  async function refreshSummary() {
    const next = await getNotificationSummary();
    setSyncStatus(await syncPayments(next.payments));
    await syncMonthlyCategoryWidget();
    await loadPeriodData();
  }

  async function addPayment() {
    const amountCents = parseAmountCents(amount);
    if (!merchant.trim() || amountCents <= 0) {
      setFormMessage("Enter a merchant and amount.");
      return;
    }

    try {
      await addManualPayment(merchant, amountCents);
      setMerchant("");
      setAmount("");
      setFormMessage("Added.");
      await refreshSummary();
    } catch (error) {
      setFormMessage(error instanceof Error ? error.message : "Could not add payment.");
    }
  }

  async function saveBudget() {
    const trimmed = budgetDraft.trim();
    const amountCents = trimmed === "" ? 0 : parseAmountCents(trimmed);
    if (trimmed !== "" && amountCents <= 0) {
      setBudgetMessage("Enter a valid amount.");
      return;
    }

    const ok = await setMonthlyBudgetCents(amountCents);
    if (ok) {
      setMonthlyBudgetCentsState(amountCents);
      setBudgetMessage("Saved.");
    } else {
      setBudgetMessage("Could not save budget.");
    }
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    setImportMessage("Reading file...");
    try {
      const statement = await parseStatementFile(file);
      if (statement.rows.length === 0) {
        setImportMessage("No transactions found.");
        return;
      }
      if (!isSupabaseConfigured()) {
        setImportMessage("Statement parsed, but Supabase is not configured in this build.");
        return;
      }
      const result = await importStatementTransactions(statement.rows, statement.source, file.name);
      setImportMessage(
        `Imported ${result.inserted} transaction${result.inserted === 1 ? "" : "s"} — ` +
          `${result.matched} matched to notifications` +
          (result.unmatched > 0 ? `, ${result.unmatched} need manual linking.` : "."),
      );
      await loadUnmatchedStatementRows();
      await loadPeriodData();
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : "Could not import file.");
    }
  }

  async function startLinking(statementId: string, statementRow: StatementTransaction) {
    setLinkingStatementId(statementId);
    setLinkMessage("");
    setLinkCandidates(await getOrphanTransactionCandidates(statementRow));
  }

  function cancelLinking() {
    setLinkingStatementId(null);
    setLinkCandidates([]);
    setLinkMessage("");
  }

  async function confirmLink(statementId: string, transactionId: string) {
    const ok = await linkStatementTransaction(statementId, transactionId);
    if (!ok) {
      setLinkMessage("Could not link transaction.");
      return;
    }
    cancelLinking();
    await loadUnmatchedStatementRows();
    await loadPeriodData();
  }

  async function openScannerSettings() {
    if (!canUseNotificationAccess()) return;

    try {
      await openNotificationAccessSettings();
      setSettingsOpen(false);
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : "Could not open Android settings.");
    }
  }

  async function openDiagnostics() {
    setSettingsOpen(false);
    setDiagnosticsOpen(true);
    setDiagnostics(await getNativeDiagnostics());
  }

  async function removePayment(id: string) {
    // Best-effort native-cache delete (keeps today's widget total right);
    // silently no-ops off-device or once the payment has left the daily
    // cache, so Supabase below is the source of truth — mirrors chooseCategory.
    try {
      await deletePayment(id);
    } catch {
      // native store unavailable (e.g. web build)
    }

    const ok = await markPaymentDeleted(id);
    if (!ok) setFormMessage("Could not delete payment.");
    setOpenPaymentMenuId(null);
    await refreshSummary();
  }

  async function chooseCategory(id: string, category: string, merchant: string, previousCategory: string) {
    // Best-effort: keeps the native widget's cache in sync, but this silently
    // no-ops if the payment already rolled out of the native today-cache
    // (or was added via manual entry/import), so it must never be relied on
    // as the source of truth — Supabase is updated directly below instead.
    try {
      await setPaymentCategory(id, category);
    } catch {
      // native store unavailable (e.g. web build) — ignore, Supabase update still applies
    }

    // Sub-categories are scoped to their parent category, so only clear the
    // existing one when the category is actually changing — otherwise
    // re-tapping the already-selected chip would silently wipe a sub-category
    // the user just picked in this same menu session.
    const ok = await updatePaymentCategory(id, category, { clearSubcategory: category !== previousCategory });
    if (!ok) {
      setFormMessage("Could not set category.");
    }
    setSubcategoryDraft("");

    // Keep the menu open when the newly-picked category has sub-categories to
    // choose from (the row revealed below needs to still be reachable);
    // otherwise close immediately, preserving today's one-tap behaviour.
    const hasSubcategories = (categories.find((item) => item.name === category)?.subcategories.length ?? 0) > 0;
    if (!hasSubcategories) {
      setOpenPaymentMenuId(null);
    }
    await refreshSummary();

    if (ok && merchant) {
      const others = await getOtherPaymentsFromMerchant(merchant, id, category);
      if (others.length > 0) {
        setBulkMessage("");
        setBulkPrompt({ merchant, category, payments: others });
      }
    }
  }

  async function chooseSubcategory(id: string, subcategory: string) {
    const ok = await updatePaymentSubcategory(id, subcategory);
    if (!ok) setFormMessage("Could not set sub-category.");
    setOpenPaymentMenuId(null);
    setSubcategoryDraft("");
    await refreshSummary();
  }

  async function applyBulkCategory() {
    if (!bulkPrompt) return;
    const ids = bulkPrompt.payments.map((payment) => payment.id);
    const ok = await setCategoryForIds(ids, bulkPrompt.category);
    if (!ok) {
      setBulkMessage("Could not update those transactions.");
      return;
    }
    // Best-effort native-cache sync for any of them still in today's cache.
    try {
      for (const paymentId of ids) {
        await setPaymentCategory(paymentId, bulkPrompt.category);
      }
    } catch {
      // native store unavailable — Supabase is the source of truth
    }
    setBulkPrompt(null);
    await refreshSummary();
  }

  async function addCategory(id: string, merchant: string, previousCategory: string) {
    const name = categoryDraft.trim();
    if (!name) return;

    const created = await createCategory(name, categories.length);
    if (!created) {
      setFormMessage("Could not add category.");
      return;
    }
    setCategories((prev) => (prev.some((item) => item.id === created.id) ? prev : [...prev, created]));

    setCategoryDraft("");
    await chooseCategory(id, created.name, merchant, previousCategory);
  }

  async function addSubcategory(id: string, categoryId: number) {
    const name = subcategoryDraft.trim();
    if (!name) return;

    // A sub-category has no existence apart from being set on a transaction
    // (see categoriesApi.ts) — setting it here via chooseSubcategory is the
    // only "creation" step needed; just track it locally so it shows up as a
    // pickable chip going forward.
    setCategories((prev) =>
      prev.map((item) =>
        item.id === categoryId && !item.subcategories.some((s) => s.toLowerCase() === name.toLowerCase())
          ? { ...item, subcategories: [...item.subcategories, name].sort((a, b) => a.localeCompare(b)) }
          : item,
      ),
    );

    await chooseSubcategory(id, name);
  }

  async function handleRenameCategory(category: CategoryDef) {
    const next = window.prompt(`Rename "${category.name}" to:`, category.name);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === category.name) return;

    const updated = await renameCategory(category, trimmed);
    if (!updated) {
      setFormMessage(`Could not rename "${category.name}" — that name may already be in use.`);
      return;
    }
    setCategories((prev) => prev.map((item) => (item.id === category.id ? updated : item)));
    if (categoryFilter === category.name) setCategoryFilter(updated.name);
    await refreshSummary();
  }

  function handleDeleteCategory(category: CategoryDef) {
    setDeletePrompt({ kind: "category", category });
  }

  async function handleRenameSubcategory(category: CategoryDef, subName: string) {
    const next = window.prompt(`Rename "${subName}" to:`, subName);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === subName) return;

    const updated = await renameSubcategory(category, subName, trimmed);
    if (!updated) {
      setFormMessage(`Could not rename "${subName}".`);
      return;
    }
    setCategories((prev) =>
      prev.map((item) =>
        item.id === category.id
          ? {
              ...item,
              subcategories: item.subcategories
                .map((s) => (s === subName ? updated : s))
                .sort((a, b) => a.localeCompare(b)),
            }
          : item,
      ),
    );
    await refreshSummary();
  }

  function handleDeleteSubcategory(category: CategoryDef, subName: string) {
    setDeletePrompt({ kind: "subcategory", category, subName });
  }

  async function confirmDelete() {
    if (!deletePrompt) return;

    if (deletePrompt.kind === "category") {
      const { category } = deletePrompt;
      const ok = await deleteCategory(category);
      if (!ok) {
        setFormMessage(`Could not delete "${category.name}".`);
        setDeletePrompt(null);
        return;
      }
      setCategories((prev) => prev.filter((item) => item.id !== category.id));
      if (categoryFilter === category.name) setCategoryFilter(null);
    } else {
      const { category, subName } = deletePrompt;
      const ok = await deleteSubcategory(category, subName);
      if (!ok) {
        setFormMessage(`Could not delete "${subName}".`);
        setDeletePrompt(null);
        return;
      }
      setCategories((prev) =>
        prev.map((item) =>
          item.id === category.id
            ? { ...item, subcategories: item.subcategories.filter((s) => s !== subName) }
            : item,
        ),
      );
    }

    setDeletePrompt(null);
    await refreshSummary();
  }

  function togglePaymentMenu(id: string) {
    const opening = openPaymentMenuId !== id;
    setOpenPaymentMenuId(opening ? id : null);
    setItemDraftName("");
    setItemDraftPrice("");
    setBreakdownMessage("");
    setMomentMessage("");
    setCategoryDraft("");
    if (opening && !breakdowns[id]) {
      void loadBreakdown(id);
    }
  }

  async function loadBreakdown(id: string) {
    const detail = await getTransactionBreakdown(id);
    if (detail) setBreakdowns((prev) => ({ ...prev, [id]: detail }));
  }

  async function scanReceipt(id: string) {
    setScanBusyId(id);
    setBreakdownMessage("");
    try {
      const image = await captureReceiptPhoto();
      if (!image) {
        setBreakdownMessage("No photo captured.");
        return;
      }

      const upload = await uploadReceiptPhoto(id, image);
      if (!upload.url) {
        setBreakdownMessage(`Upload failed: ${upload.error ?? "unknown error"}`);
        return;
      }
      const receiptUrl = upload.url;
      const saved = await saveReceiptImage(id, receiptUrl);
      if (!saved) {
        setBreakdownMessage("Uploaded, but saving the link failed.");
        return;
      }

      setBreakdowns((prev) => ({
        ...prev,
        [id]: { items: prev[id]?.items ?? [], receiptImage: receiptUrl, photoUrl: prev[id]?.photoUrl ?? null },
      }));
      setBreakdownMessage("Receipt saved. Reading items...");

      const extracted = await extractReceiptItems(image);
      if (extracted.length === 0) {
        setBreakdownMessage("Receipt saved. No items detected — add them manually below.");
        return;
      }

      const added: ReceiptItem[] = [];
      for (const item of extracted) {
        const saved = await addReceiptItem(id, item.name, item.priceCents);
        if (saved) added.push(saved);
      }

      setBreakdowns((prev) => ({
        ...prev,
        [id]: {
          receiptImage: receiptUrl,
          photoUrl: prev[id]?.photoUrl ?? null,
          items: [...(prev[id]?.items ?? []), ...added],
        },
      }));
      setBreakdownMessage(
        added.length > 0
          ? `Receipt saved. Added ${added.length} item${added.length === 1 ? "" : "s"} — review and edit below.`
          : "Receipt saved. Could not read items — add them manually below.",
      );
    } finally {
      setScanBusyId(null);
    }
  }

  async function takePhoto(id: string) {
    setMomentBusyId(id);
    setMomentMessage("");
    try {
      const image = await captureReceiptPhoto();
      if (!image) {
        setMomentMessage("No photo captured.");
        return;
      }

      const upload = await uploadMomentPhoto(id, image);
      if (!upload.url) {
        setMomentMessage(`Upload failed: ${upload.error ?? "unknown error"}`);
        return;
      }
      const saved = await savePhoto(id, upload.url);
      if (!saved) {
        setMomentMessage("Uploaded, but saving the link failed — does transactions.photo_url exist? (migration 20260724c)");
        return;
      }

      setBreakdowns((prev) => ({
        ...prev,
        [id]: {
          items: prev[id]?.items ?? [],
          receiptImage: prev[id]?.receiptImage ?? null,
          photoUrl: upload.url,
        },
      }));
      setMomentMessage("Photo saved.");
    } finally {
      setMomentBusyId(null);
    }
  }

  async function addItem(id: string) {
    const name = itemDraftName.trim();
    const priceCents = parseAmountCents(itemDraftPrice);
    if (!name || priceCents <= 0) {
      setBreakdownMessage("Enter an item name and price.");
      return;
    }

    const item = await addReceiptItem(id, name, priceCents);
    if (item) {
      setBreakdowns((prev) => ({
        ...prev,
        [id]: {
          receiptImage: prev[id]?.receiptImage ?? null,
          photoUrl: prev[id]?.photoUrl ?? null,
          items: [...(prev[id]?.items ?? []), item],
        },
      }));
      setItemDraftName("");
      setItemDraftPrice("");
      setBreakdownMessage("");
    } else {
      setBreakdownMessage("Could not save item.");
    }
  }

  async function removeItem(id: string, itemId: number) {
    const ok = await removeReceiptItem(itemId);
    if (ok) {
      setBreakdowns((prev) => ({
        ...prev,
        [id]: {
          receiptImage: prev[id]?.receiptImage ?? null,
          photoUrl: prev[id]?.photoUrl ?? null,
          items: (prev[id]?.items ?? []).filter((item) => item.id !== itemId),
        },
      }));
    }
  }

  const budgetPercent =
    monthlyBudgetCents > 0 ? Math.round((periodTotalCents / monthlyBudgetCents) * 100) : 0;
  const budgetOverCents = periodTotalCents > monthlyBudgetCents ? periodTotalCents - monthlyBudgetCents : 0;
  const now = new Date();
  const isCurrentPeriod =
    periodRange === "month"
      ? periodDate.getFullYear() === now.getFullYear() && periodDate.getMonth() === now.getMonth()
      : periodDate.getFullYear() === now.getFullYear();
  const daysLeftInMonth = Math.max(
    0,
    Math.ceil((new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() - now.getTime()) / 86_400_000),
  );
  const budgetRemainingCents = monthlyBudgetCents - periodTotalCents;

  const trendPercent =
    previousPeriodTotalCents !== null && previousPeriodTotalCents > 0
      ? Math.round(((periodTotalCents - previousPeriodTotalCents) / previousPeriodTotalCents) * 100)
      : null;

  const maxCategoryAmount = Math.max(0, ...periodTotals.map((item) => item.amountCents));
  const categoryTotals = periodTotals.map((item) => {
    const color = categoryColorMap.get(item.category.toLowerCase()) ?? "#8b9cb3";
    return {
      ...item,
      percent: maxCategoryAmount > 0 ? Math.max(6, Math.round((item.amountCents / maxCategoryAmount) * 100)) : 0,
      color,
      segments: buildBarSegments(item, color),
    };
  });

  const filteredPayments = categoryFilter
    ? periodPayments.filter((payment) => (payment.category ?? inferCategory(payment.merchant)) === categoryFilter)
    : periodPayments;

  const dailyTotals = (() => {
    const totals = new Map<string, number>();
    for (const payment of filteredPayments) {
      totals.set(payment.paymentDate, (totals.get(payment.paymentDate) ?? 0) + payment.amountCents);
    }
    return [...totals.entries()]
      .map(([date, amountCents]) => ({ date, amountCents }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  })();

  return (
    <main className="app app--scanner">
      <section className="scanner-total">
        <div className="scanner-total__top">
          <div className="period-filter">
            <div className="period-filter__tabs">
              {(["month", "year"] as const).map((range) => (
                <button
                  key={range}
                  type="button"
                  className={
                    periodRange === range
                      ? "period-filter__tab period-filter__tab--active"
                      : "period-filter__tab"
                  }
                  onClick={() => setPeriodRange(range)}
                >
                  {range === "month" ? "Month" : "Year"}
                </button>
              ))}
            </div>
            {periodRange === "month" && (
              <input
                type="month"
                className="period-filter__input"
                value={toMonthInputValue(periodDate)}
                max={toMonthInputValue(new Date())}
                onChange={(event) => {
                  const parsed = parseMonthInputValue(event.target.value);
                  if (!parsed) return;
                  setPeriodDate(parsed > new Date() ? new Date() : parsed);
                }}
              />
            )}
            {periodRange === "year" && (
              <input
                type="number"
                className="period-filter__input"
                value={periodDate.getFullYear()}
                max={new Date().getFullYear()}
                onChange={(event) => {
                  const year = Number(event.target.value);
                  if (!Number.isFinite(year)) return;
                  const clampedYear = Math.min(year, new Date().getFullYear());
                  setPeriodDate((prev) => new Date(clampedYear, prev.getMonth(), 1));
                }}
              />
            )}
          </div>
          <div className="settings-shell">
            <button
              type="button"
              className="settings-cog"
              aria-expanded={settingsOpen}
              aria-label="Open settings"
              title="Settings"
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <Settings aria-hidden="true" size={22} strokeWidth={2.25} />
            </button>
            {settingsOpen && (
              <>
                <div className="settings-menu-backdrop" onClick={() => setSettingsOpen(false)} />
                <div className="settings-menu">
                <button
                  type="button"
                  className="settings-menu__item"
                  disabled={!canUseNotificationAccess()}
                  onClick={() => void openScannerSettings()}
                >
                  Notification scanner settings
                </button>
                <button
                  type="button"
                  className="settings-menu__item"
                  onClick={() => void openDiagnostics()}
                >
                  Diagnostics
                </button>
                <div className="settings-menu__section">
                  <p className="settings-menu__label">Monthly budget</p>
                  <div className="settings-menu__fields">
                    <input
                      value={budgetDraft}
                      onChange={(event) => setBudgetDraft(event.target.value)}
                      placeholder="e.g. 1500"
                      inputMode="decimal"
                    />
                    <button type="button" onClick={() => void saveBudget()}>
                      Save
                    </button>
                  </div>
                  {budgetMessage && <p className="manual-entry__message">{budgetMessage}</p>}
                </div>
                <div className="settings-menu__section">
                  <p className="settings-menu__label">Filter by category</p>
                  <select
                    className="settings-menu__select"
                    value={categoryFilter ?? ""}
                    onChange={(event) => setCategoryFilter(event.target.value || null)}
                  >
                    <option value="">All categories</option>
                    {sortedCategoryNames.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="settings-menu__section">
                  <label className="settings-menu__checkbox">
                    <input
                      type="checkbox"
                      checked={collapseDaily}
                      onChange={(event) => setCollapseDaily(event.target.checked)}
                    />
                    Show daily totals only
                  </label>
                </div>
                <div className="settings-menu__section">
                  <button
                    type="button"
                    className="settings-menu__collapsible-label"
                    aria-expanded={manageCategoriesOpen}
                    onClick={() => setManageCategoriesOpen((open) => !open)}
                  >
                    <span>Manage categories</span>
                    {manageCategoriesOpen ? (
                      <ChevronDown aria-hidden="true" size={16} />
                    ) : (
                      <ChevronRight aria-hidden="true" size={16} />
                    )}
                  </button>
                  {manageCategoriesOpen && (
                  <ul className="manage-categories">
                    {sortedCategories.map((cat) => (
                      <li key={cat.id} className="manage-categories__category">
                        <div className="manage-categories__row">
                          <span
                            className="payment-category"
                            style={{ "--category-color": cat.color } as CSSProperties}
                          >
                            {cat.name}
                          </span>
                          <div className="manage-categories__actions">
                            <button type="button" onClick={() => void handleRenameCategory(cat)}>
                              Rename
                            </button>
                            <button
                              type="button"
                              className="manage-categories__delete"
                              onClick={() => void handleDeleteCategory(cat)}
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                        {cat.subcategories.length > 0 && (
                          <ul className="manage-categories__subcategories">
                            {cat.subcategories.map((sub) => (
                              <li key={sub} className="manage-categories__row">
                                <span>{sub}</span>
                                <div className="manage-categories__actions">
                                  <button type="button" onClick={() => void handleRenameSubcategory(cat, sub)}>
                                    Rename
                                  </button>
                                  <button
                                    type="button"
                                    className="manage-categories__delete"
                                    onClick={() => void handleDeleteSubcategory(cat, sub)}
                                  >
                                    Delete
                                  </button>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ul>
                  )}
                </div>
                <div className="settings-menu__section">
                  <p className="settings-menu__label">Add missed payment</p>
                  <div className="settings-menu__fields">
                    <input
                      value={merchant}
                      onChange={(event) => setMerchant(event.target.value)}
                      placeholder="Merchant"
                      inputMode="text"
                    />
                    <input
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      placeholder="Amount"
                      inputMode="decimal"
                    />
                    <button type="button" onClick={() => void addPayment()}>
                      Add
                    </button>
                  </div>
                  {formMessage && <p className="manual-entry__message">{formMessage}</p>}
                </div>
                <div className="settings-menu__section">
                  <p className="settings-menu__label">Import payments</p>
                  <label className="file-picker">
                    <input
                      type="file"
                      accept=".csv,.pdf,text/csv,application/pdf"
                      onChange={(event) => void importFile(event.target.files?.[0])}
                    />
                    Upload CSV or PDF
                  </label>
                  {importMessage && <p className="manual-entry__message">{importMessage}</p>}
                </div>
                </div>
              </>
            )}
          </div>
        </div>

        <p className="scanner-total__amount">{formatGbp(periodTotalCents)}</p>
        <div className="scanner-total__stats">
          {trendPercent !== null && (
            <span className={`trend-badge${trendPercent > 0 ? " trend-badge--up" : " trend-badge--down"}`}>
              {trendPercent > 0 ? <TrendingUp size={13} aria-hidden="true" /> : <TrendingDown size={13} aria-hidden="true" />}
              {Math.abs(trendPercent)}% vs {previousPeriodLabel(periodRange, periodDate)}
            </span>
          )}
          <span className="scanner-total__count">{periodPayments.length} payments</span>
        </div>
        <p className={`sync-status sync-status--${syncStatus}`}>
          {syncStatus === "synced"
            ? "Synced to Supabase"
            : syncStatus === "error"
              ? "Supabase sync failed"
              : "Supabase not configured in this build"}
        </p>
      </section>

      {periodRange === "month" && monthlyBudgetCents > 0 && (
        <section className="budget-chart">
          <div className="budget-chart__meta">
            <span>Monthly budget</span>
            <strong>
              {formatGbp(periodTotalCents)}
              <span className="budget-chart__of"> of {formatGbp(monthlyBudgetCents)}</span>
            </strong>
          </div>
          <div className={`budget-chart__track${budgetPercent >= 100 ? " budget-chart__track--over" : ""}`} aria-hidden="true">
            <div
              className="budget-chart__bar"
              style={{ width: `${Math.min(100, Math.max(0, budgetPercent))}%` }}
            >
              {categoryTotals.map((item) => (
                <div
                  key={item.category}
                  className="budget-chart__segment"
                  style={{ flexGrow: item.amountCents, flexBasis: 0, background: item.color }}
                  title={`${item.category}: ${formatGbp(item.amountCents)}`}
                />
              ))}
            </div>
          </div>
          {budgetOverCents > 0 ? (
            <p className="budget-chart__over">{formatGbp(budgetOverCents)} over budget</p>
          ) : (
            <p className="budget-chart__remaining">
              {formatGbp(budgetRemainingCents)} left
              {isCurrentPeriod ? ` with ${daysLeftInMonth} days to go` : ""}
            </p>
          )}
        </section>
      )}

      <section className="category-chart">
        <div className="category-chart__header">
          <span>Categories</span>
        </div>
        {categoryTotals.length > 0 ? (
          <ul className="category-chart__list">
            {categoryTotals.map((item) => (
              <li key={item.category} className="category-chart__row">
                <div className="category-chart__meta">
                  <span className="category-chart__name">
                    <span className="category-chart__dot" style={{ background: item.color }} aria-hidden="true" />
                    {item.category}
                    {item.subcategories.length > 0 && (
                      <span className="category-chart__subcategories">
                        {" "}
                        | {item.subcategories.map((sub) => sub.subcategory).join(", ")}
                      </span>
                    )}
                  </span>
                  <strong>{formatGbp(item.amountCents)}</strong>
                </div>
                <div className="category-chart__track" aria-hidden="true">
                  {item.segments.length > 0 ? (
                    <div className="category-chart__bar" style={{ width: `${item.percent}%` }}>
                      {item.segments.map((segment) => (
                        <div
                          key={segment.key || "remainder"}
                          className="category-chart__segment"
                          style={{ flexGrow: segment.amountCents, flexBasis: 0, background: segment.color }}
                          title={segment.label ?? undefined}
                        />
                      ))}
                    </div>
                  ) : (
                    <div
                      className="category-chart__bar"
                      style={{ width: `${item.percent}%`, background: item.color }}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="category-chart__empty">No payments counted yet.</p>
        )}
      </section>

      <section className="last-alert">
        <div className="last-alert__header">
          <p className="last-alert__label">Payments</p>
          {categoryFilter && (
            <button type="button" className="clear-filter-btn" onClick={() => setCategoryFilter(null)}>
              {categoryFilter} ×
            </button>
          )}
        </div>
        {filteredPayments.length > 0 ? (
          collapseDaily ? (
            <ul className="payment-list">
              {dailyTotals.map((day) => (
                <li key={day.date} className="daily-total-row">
                  <span>{dateDividerLabel(day.date, periodRange)}</span>
                  <strong>{formatGbp(day.amountCents)}</strong>
                </li>
              ))}
            </ul>
          ) : (
          <ul className="payment-list">
            {(() => {
              return filteredPayments.map((payment, index) => {
              const showDateDivider =
                index === 0 || filteredPayments[index - 1]?.paymentDate !== payment.paymentDate;
              const menuOpen = openPaymentMenuId === payment.id;
              const category = payment.category ?? inferCategory(payment.merchant);
              const selectedCategoryDef = categories.find((item) => item.name === category);
              const categoryColor = categoryColorMap.get(category.toLowerCase()) ?? "#8b9cb3";
              const rowUrl = getSupabaseRowUrl(payment.id);
              const breakdown = breakdowns[payment.id];
              const items = breakdown?.items ?? [];
              const itemsTotalCents = items.reduce((total, item) => total + item.priceCents, 0);

              return (
                <Fragment key={payment.id}>
                {showDateDivider && (
                  <li className="payment-date-divider">
                    <span>{dateDividerLabel(payment.paymentDate, periodRange)}</span>
                  </li>
                )}
                <li className="last-alert__row">
                  <div className="last-alert__lead">
                    {payment.photoUrl && (
                      <button
                        type="button"
                        className="payment-photo-thumb"
                        aria-label={`View photo for ${payment.merchant}`}
                        onClick={() => window.open(payment.photoUrl as string, "_blank", "noopener,noreferrer")}
                      >
                        <img src={payment.photoUrl} alt="" loading="lazy" />
                      </button>
                    )}
                    <div className="last-alert__merchant">
                      <span>{payment.merchant}</span>
                      <div className="payment-category-row">
                        <span
                          className="payment-category"
                          style={{ "--category-color": categoryColor } as CSSProperties}
                        >
                          {category}
                        </span>
                        {payment.subcategory && (
                          <span className="payment-subcategory">{payment.subcategory}</span>
                        )}
                        {payment.cardSource && (
                          <span className="payment-subcategory">{cardSourceLabel(payment.cardSource)}</span>
                        )}
                      </div>
                      {orphanedIds.has(payment.id) && (
                        <span className="payment-orphan-flag" title="No matching statement transaction found">
                          No statement match
                        </span>
                      )}
                    </div>
                  </div>
                  <strong>{payment.amount}</strong>
                  <div className="payment-actions">
                    <button
                      type="button"
                      className="payment-actions__menu"
                      aria-expanded={menuOpen}
                      aria-label={`Payment actions for ${payment.merchant} ${payment.amount}`}
                      onClick={() => togglePaymentMenu(payment.id)}
                    >
                      ...
                    </button>
                  </div>
                  {menuOpen && (
                    <div className="payment-menu-overlay">
                      <div
                        className="payment-menu-backdrop"
                        onClick={() => setOpenPaymentMenuId(null)}
                      />
                      <div
                        className="payment-menu"
                        role="dialog"
                        aria-modal="true"
                        aria-label={`Payment actions for ${payment.merchant} ${payment.amount}`}
                      >
                        <button
                          type="button"
                          className="payment-menu__handle"
                          aria-label="Close"
                          onClick={() => setOpenPaymentMenuId(null)}
                        />
                        <div className="payment-menu__sheet-header">
                          <div className="payment-menu__sheet-title">
                            <span>{payment.merchant}</span>
                            <strong>{payment.amount}</strong>
                          </div>
                          <button
                            type="button"
                            className="payment-menu__close"
                            aria-label="Close menu"
                            onClick={() => setOpenPaymentMenuId(null)}
                          >
                            ×
                          </button>
                        </div>
                        <div className="payment-menu__body">
                          <p className="payment-menu__label">Category</p>
                          <div className="payment-menu__categories">
                            {sortedCategoryNames.map((option) => (
                              <button
                                key={option}
                                type="button"
                                className={
                                  option === category
                                    ? "payment-menu__category payment-menu__category--active"
                                    : "payment-menu__category"
                                }
                                onClick={() => void chooseCategory(payment.id, option, payment.merchant, category)}
                              >
                                {option}
                              </button>
                            ))}
                          </div>
                          <div className="payment-menu__add-category">
                            <input
                              value={categoryDraft}
                              onChange={(event) => setCategoryDraft(event.target.value)}
                              placeholder="New category"
                              inputMode="text"
                            />
                            <button
                              type="button"
                              onClick={() => void addCategory(payment.id, payment.merchant, category)}
                            >
                              Add
                            </button>
                          </div>
                          {selectedCategoryDef && (
                            <>
                              <p className="payment-menu__label">Sub-category</p>
                              <div className="payment-menu__categories">
                                {selectedCategoryDef.subcategories.map((sub) => (
                                  <button
                                    key={sub}
                                    type="button"
                                    className={
                                      sub === payment.subcategory
                                        ? "payment-menu__category payment-menu__category--active"
                                        : "payment-menu__category"
                                    }
                                    onClick={() => void chooseSubcategory(payment.id, sub)}
                                  >
                                    {sub}
                                  </button>
                                ))}
                              </div>
                              <div className="payment-menu__add-category">
                                <input
                                  value={subcategoryDraft}
                                  onChange={(event) => setSubcategoryDraft(event.target.value)}
                                  placeholder="New sub-category"
                                  inputMode="text"
                                />
                                <button
                                  type="button"
                                  onClick={() => void addSubcategory(payment.id, selectedCategoryDef.id)}
                                >
                                  Add
                                </button>
                              </div>
                            </>
                          )}
                          {isSupabaseConfigured() && (
                            <div className="payment-menu__section">
                              <p className="payment-menu__label">Receipt</p>
                              <div className="receipt-scan-row">
                                {breakdown?.receiptImage && (
                                  <button
                                    type="button"
                                    className="receipt-thumb"
                                    aria-label={`View receipt photo for ${payment.merchant}`}
                                    onClick={() =>
                                      window.open(breakdown.receiptImage as string, "_blank", "noopener,noreferrer")
                                    }
                                  >
                                    <img src={breakdown.receiptImage} alt="" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="scan-receipt-btn"
                                  disabled={scanBusyId === payment.id}
                                  onClick={() => void scanReceipt(payment.id)}
                                >
                                  {scanBusyId === payment.id
                                    ? "Scanning..."
                                    : breakdown?.receiptImage
                                      ? "Retake photo"
                                      : "Scan receipt"}
                                </button>
                              </div>

                              <p className="payment-menu__label">
                                Items{items.length > 0 ? ` — ${formatGbp(itemsTotalCents)}` : ""}
                              </p>
                              {items.length > 0 && (
                                <ul className="receipt-items">
                                  {items.map((item) => (
                                    <li key={item.id} className="receipt-items__row">
                                      <span>{item.name}</span>
                                      <strong>{formatGbp(item.priceCents)}</strong>
                                      <button
                                        type="button"
                                        className="receipt-items__remove"
                                        aria-label={`Remove ${item.name}`}
                                        onClick={() => void removeItem(payment.id, item.id)}
                                      >
                                        ×
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              )}
                              <div className="receipt-item-add">
                                <input
                                  value={itemDraftName}
                                  onChange={(event) => setItemDraftName(event.target.value)}
                                  placeholder="Item"
                                  inputMode="text"
                                />
                                <input
                                  value={itemDraftPrice}
                                  onChange={(event) => setItemDraftPrice(event.target.value)}
                                  placeholder="Price"
                                  inputMode="decimal"
                                />
                                <button type="button" onClick={() => void addItem(payment.id)}>
                                  Add
                                </button>
                              </div>
                              {breakdownMessage && <p className="manual-entry__message">{breakdownMessage}</p>}
                            </div>
                          )}
                          {isSupabaseConfigured() && (
                            <div className="payment-menu__section">
                              <p className="payment-menu__label">Photo</p>
                              <div className="receipt-scan-row">
                                {breakdown?.photoUrl && (
                                  <button
                                    type="button"
                                    className="receipt-thumb"
                                    aria-label={`View photo for ${payment.merchant}`}
                                    onClick={() =>
                                      window.open(breakdown.photoUrl as string, "_blank", "noopener,noreferrer")
                                    }
                                  >
                                    <img src={breakdown.photoUrl} alt="" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="scan-receipt-btn"
                                  disabled={momentBusyId === payment.id}
                                  onClick={() => void takePhoto(payment.id)}
                                >
                                  {momentBusyId === payment.id
                                    ? "Saving..."
                                    : breakdown?.photoUrl
                                      ? "Retake photo"
                                      : "Take photo"}
                                </button>
                              </div>
                              {momentMessage && <p className="manual-entry__message">{momentMessage}</p>}
                            </div>
                          )}
                        </div>
                        <div className="payment-menu__footer">
                          {rowUrl && (
                            <button
                              type="button"
                              className="show-in-supabase-btn"
                              aria-label={`Show ${payment.merchant} ${payment.amount} in Supabase`}
                              onClick={() => window.open(rowUrl, "_blank", "noopener,noreferrer")}
                            >
                              Show in Supabase
                            </button>
                          )}
                          <button
                            type="button"
                            className="delete-payment-btn"
                            aria-label={`Delete ${payment.merchant} ${payment.amount}`}
                            onClick={() => void removePayment(payment.id)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                </li>
                </Fragment>
              );
              });
            })()}
          </ul>
          )
        ) : (
          <p className="last-alert__empty">
            {categoryFilter ? `No ${categoryFilter} payments in this period.` : "No payments in this period."}
          </p>
        )}
      </section>

      {unmatchedStatementRows.length > 0 && (
        <section className="unmatched-statement">
          <div className="last-alert__header">
            <p className="last-alert__label">Unmatched statement items</p>
          </div>
          <ul className="payment-list">
            {unmatchedStatementRows.map((row) => (
              <li key={row.id} className="last-alert__row">
                <div className="last-alert__merchant">
                  <span>{row.merchant}</span>
                  <span className="payment-category">{row.source}</span>
                </div>
                <strong>{row.amount}</strong>
                <div className="payment-actions">
                  <button type="button" className="link-statement-btn" onClick={() => void startLinking(row.id, row)}>
                    Link
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {linkingStatementId && (
        <div className="payment-menu-overlay">
          <div className="payment-menu-backdrop" onClick={cancelLinking} />
          <div className="payment-menu" role="dialog" aria-modal="true" aria-label="Link statement transaction">
            <button type="button" className="payment-menu__handle" aria-label="Close" onClick={cancelLinking} />
            <div className="payment-menu__sheet-header">
              <div className="payment-menu__sheet-title">
                <span>Pick the matching transaction</span>
              </div>
              <button type="button" className="payment-menu__close" aria-label="Close menu" onClick={cancelLinking}>
                ×
              </button>
            </div>
            <div className="payment-menu__body">
              {linkCandidates.length > 0 ? (
                <ul className="payment-list">
                  {linkCandidates.map((candidate) => (
                    <li key={candidate.id} className="last-alert__row">
                      <div className="last-alert__merchant">
                        <span>{candidate.merchant}</span>
                        <span className="payment-category">{candidate.paymentDate}</span>
                      </div>
                      <strong>{candidate.amount}</strong>
                      <div className="payment-actions">
                        <button
                          type="button"
                          className="link-statement-btn"
                          onClick={() => void confirmLink(linkingStatementId, candidate.id)}
                        >
                          Select
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="last-alert__empty">No unlinked notification transactions to match.</p>
              )}
              {linkMessage && <p className="manual-entry__message">{linkMessage}</p>}
            </div>
          </div>
        </div>
      )}

      {bulkPrompt && (
        <div className="payment-menu-overlay">
          <div className="payment-menu-backdrop" onClick={() => setBulkPrompt(null)} />
          <div
            className="payment-menu"
            role="dialog"
            aria-modal="true"
            aria-label={`Categorise all ${bulkPrompt.merchant} transactions`}
          >
            <button type="button" className="payment-menu__handle" aria-label="Close" onClick={() => setBulkPrompt(null)} />
            <div className="payment-menu__sheet-header">
              <div className="payment-menu__sheet-title">
                <span>Categorise all {bulkPrompt.merchant}?</span>
                <strong>
                  Apply “{bulkPrompt.category}” to {bulkPrompt.payments.length} more transaction
                  {bulkPrompt.payments.length === 1 ? "" : "s"}
                </strong>
              </div>
              <button
                type="button"
                className="payment-menu__close"
                aria-label="Close menu"
                onClick={() => setBulkPrompt(null)}
              >
                ×
              </button>
            </div>
            <div className="payment-menu__body">
              <ul className="payment-list">
                {bulkPrompt.payments.map((payment) => {
                  const current = payment.category ?? inferCategory(payment.merchant);
                  return (
                    <li key={payment.id} className="last-alert__row">
                      <div className="last-alert__merchant">
                        <span>{payment.paymentDate}</span>
                        <span
                          className="payment-category"
                          style={{ "--category-color": categoryColorMap.get(current.toLowerCase()) ?? "#8b9cb3" } as CSSProperties}
                        >
                          {current}
                        </span>
                      </div>
                      <strong>{payment.amount}</strong>
                    </li>
                  );
                })}
              </ul>
              {bulkMessage && <p className="manual-entry__message">{bulkMessage}</p>}
            </div>
            <div className="payment-menu__footer">
              <button type="button" className="link-statement-btn" onClick={() => setBulkPrompt(null)}>
                Just that one
              </button>
              <button type="button" className="bulk-apply-btn" onClick={() => void applyBulkCategory()}>
                Apply to all
              </button>
            </div>
          </div>
        </div>
      )}

      {deletePrompt && (
        <div className="payment-menu-overlay">
          <div className="payment-menu-backdrop" onClick={() => setDeletePrompt(null)} />
          <div className="payment-menu" role="dialog" aria-modal="true" aria-label="Confirm delete">
            <button
              type="button"
              className="payment-menu__handle"
              aria-label="Close"
              onClick={() => setDeletePrompt(null)}
            />
            <div className="payment-menu__sheet-header">
              <div className="payment-menu__sheet-title">
                <span>
                  {deletePrompt.kind === "category"
                    ? `Delete "${deletePrompt.category.name}"?`
                    : `Delete "${deletePrompt.subName}"?`}
                </span>
                <strong>
                  {deletePrompt.kind === "category"
                    ? "Any transactions using it will become uncategorized."
                    : "Any transactions using it will lose that sub-category."}
                </strong>
              </div>
              <button
                type="button"
                className="payment-menu__close"
                aria-label="Close menu"
                onClick={() => setDeletePrompt(null)}
              >
                ×
              </button>
            </div>
            <div className="payment-menu__footer">
              <button type="button" className="link-statement-btn" onClick={() => setDeletePrompt(null)}>
                Cancel
              </button>
              <button type="button" className="delete-payment-btn" onClick={() => void confirmDelete()}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {diagnosticsOpen && (
        <div className="payment-menu-overlay">
          <div className="payment-menu-backdrop" onClick={() => setDiagnosticsOpen(false)} />
          <div className="payment-menu" role="dialog" aria-modal="true" aria-label="Diagnostics">
            <button
              type="button"
              className="payment-menu__handle"
              aria-label="Close"
              onClick={() => setDiagnosticsOpen(false)}
            />
            <div className="payment-menu__sheet-header">
              <div className="payment-menu__sheet-title">
                <span>Diagnostics</span>
              </div>
              <button
                type="button"
                className="payment-menu__close"
                aria-label="Close menu"
                onClick={() => setDiagnosticsOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="payment-menu__body">
              {diagnostics ? (
                <>
                  <ul className="diagnostics-list">
                    <li>
                      <span>Notification access</span>
                      <strong>{diagnostics.notificationAccessEnabled ? "Enabled" : "Disabled"}</strong>
                    </li>
                    <li>
                      <span>Listener</span>
                      <strong>{diagnostics.listenerConnected ? "Connected" : "Disconnected"}</strong>
                    </li>
                    <li>
                      <span>Last notification</span>
                      <strong>{formatDiagnosticTime(diagnostics.lastNotificationAt)}</strong>
                    </li>
                    <li>
                      <span>Last accepted payment</span>
                      <strong>
                        {diagnostics.lastAcceptedMerchant
                          ? `${diagnostics.lastAcceptedMerchant} ${diagnostics.lastAcceptedAmount ?? ""}`.trim()
                          : "None yet"}
                      </strong>
                    </li>
                    <li>
                      <span>Pending upload</span>
                      <strong>{diagnostics.pendingUploadCount}</strong>
                    </li>
                    <li>
                      <span>Last Supabase sync</span>
                      <strong>
                        {syncStatus === "synced" ? "Successful" : syncStatus === "error" ? "Failed" : "Not configured"}
                      </strong>
                    </li>
                  </ul>
                  <p className="settings-menu__label" style={{ marginTop: "1rem" }}>
                    Recent notification activity
                  </p>
                  {diagnostics.diagnostics.length > 0 ? (
                    <ul className="diagnostics-log">
                      {diagnostics.diagnostics.map((entry, index) => (
                        <li key={`${entry.at}-${index}`}>
                          <span className="diagnostics-log__outcome">{outcomeLabel(entry.outcome)}</span>
                          <span className="diagnostics-log__meta">
                            {formatDiagnosticTime(entry.at)}
                            {entry.detail ? ` · ${entry.detail}` : ""}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="last-alert__empty">No notification activity recorded yet.</p>
                  )}
                </>
              ) : (
                <p className="last-alert__empty">
                  {canUseNotificationAccess() ? "Loading…" : "Diagnostics are only available in the Android app."}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

// One-off read of the localStorage key this app used for custom categories
// before they moved to Supabase — only needed for the one-time migration in
// initCategories, so it isn't worth re-adding as a categories.ts export.
function loadLegacyCustomCategoryNames(): string[] {
  try {
    const raw = localStorage.getItem("customCategories");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseAmountCents(value: string): number {
  const normalised = value.replace(/[£,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(normalised)) return 0;
  const [pounds, pence = ""] = normalised.split(".");
  return Number(pounds) * 100 + Number(pence.padEnd(2, "0"));
}

function toMonthInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function parseMonthInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, 1);
}

function previousPeriodDate(range: CategoryRange, date: Date): Date {
  if (range === "year") return new Date(date.getFullYear() - 1, date.getMonth(), 1);
  return new Date(date.getFullYear(), date.getMonth() - 1, 1);
}

function previousPeriodLabel(range: CategoryRange, date: Date): string {
  const previous = previousPeriodDate(range, date);
  return range === "year" ? String(previous.getFullYear()) : previous.toLocaleDateString("en-GB", { month: "long" });
}

function cardSourceLabel(cardSource: string): string {
  if (cardSource === "chase") return "Chase";
  if (cardSource === "amex") return "Amex";
  return cardSource;
}

function formatDiagnosticTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const OUTCOME_LABELS: Record<string, string> = {
  accepted: "Accepted",
  wrong_app: "Wrong app",
  no_content: "No content",
  no_amount: "No £ amount",
  refund_or_declined: "Refund or declined",
  not_recognised_as_spend: "Not recognised as spend",
  unparseable_amount: "Couldn't parse amount",
  duplicate: "Duplicate",
};

function outcomeLabel(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome;
}

function dateDividerLabel(dateStr: string, range: CategoryRange): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return dateStr;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Month view repeats within one month, so weekday+day is unambiguous;
  // year view spans months, so include the month.
  return date.toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    ...(range === "year" ? { month: "short" } : {}),
  });
}

function formatGbp(cents: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
  }).format(cents / 100);
}
