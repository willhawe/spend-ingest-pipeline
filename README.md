# Personal Spending Pipeline

[![Build Android APK](https://github.com/willhawe/spend-ingest-pipeline/actions/workflows/build-apk.yml/badge.svg)](https://github.com/willhawe/spend-ingest-pipeline/actions/workflows/build-apk.yml)

An Android + React app that turns three unstructured sources — payment notifications, bank statement exports, and photographed receipts — into a single reconciled, categorized transaction ledger with home-screen widgets. No bank API, OAuth grant, or third-party aggregator is used anywhere in the pipeline; every source is either generated on-device or manually exported by the user.

<img src="docs/screenshot-month.jpg" alt="Month view: category totals and spend bar chart" width="320">

## Pipeline

```
┌─────────────────────┐   ┌────────────────────────┐   ┌───────────────────┐
│ Notification listener│   │ Statement upload       │   │ Receipt photo     │
│ (Google Wallet, Chase,│   │ (Chase/Amex PDF, CSV)  │   │ (Capacitor Camera)│
│  Amex payment alerts) │   │ src/importPayments.ts  │   │                   │
└──────────┬───────────┘   └───────────┬────────────┘   └─────────┬─────────┘
           │ real-time, on-device       │ per-issuer regex parsers │ OCR (tesseract.js)
           ▼                            ▼                          ▼
   SharedPreferences cache      Parsed statement rows      Extracted line items
           │                            │                          │
           └───────────────┬────────────┘                          │
                            ▼                                      │
                  Reconciliation: match statement rows to           │
                  notification-derived transactions by              │
                  merchant/amount/date; surface unmatched            │
                  rows for manual linking (src/App.tsx)              │
                            │                                       │
                            ▼                                       ▼
                 Supabase / Postgres (transactions, categories, transaction_items)
                            │
                            ▼
        React app UI  +  two native Android AppWidgetProviders
        (daily total, monthly category breakdown — hand-rendered
         Canvas bar chart, since widgets can't host arbitrary views)
```

## What it does

- **Notification scanner** — an Android `NotificationListenerService` parses Google Wallet, Chase, and Amex-style payment notifications locally on the phone as they arrive; no data leaves the device until it's synced to your own Supabase project.
- **Statement import & reconciliation** — upload a Chase or Amex PDF statement (or a generic CSV); per-issuer parsers extract merchant/amount/date, then match each row against existing notification-derived transactions. Anything that doesn't match is queued for manual linking instead of silently duplicating.
- **Receipt OCR** — photograph a receipt and `tesseract.js` (with a grayscale/contrast preprocessing pass) extracts line items, filtering out totals, tender lines, and self-checkout UI chrome, so you get itemized spend without manual entry.
- **Category taxonomy** — Postgres-backed categories with per-category color and free-form sub-categories, including bulk re-categorization across a merchant's full history and a one-time migration path from an earlier localStorage-only version.
- **Home-screen widgets** — a daily spend total and a monthly category breakdown, the latter a hand-drawn stacked bar chart rendered directly onto a `Canvas` bitmap in native Java (Android widgets can't host arbitrary views, so the chart is rasterized on every update).
- **Soft delete, photo attachments, and Supabase deep-links** — every transaction can carry a receipt photo and a separate "moment" photo, deletions are soft (recoverable), and each row links straight to its Supabase table editor entry for debugging.

## Run locally

**Requirements:** Node.js 20+

```bash
npm install
npm run dev
```

Open the URL shown in the terminal, usually `http://localhost:5173`.

Production build:

```bash
npm run build
npm run preview
```

Build the Android APK:

```bash
cd android
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./gradlew :app:assembleDebug
```

The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. CI (`.github/workflows/build-apk.yml`) builds the same debug APK on every push to `main` and uploads it as an artifact.

## Supabase sync

Create `.env.local` in the project root:

```env
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=your_publishable_key
```

Only use the publishable/anon key in this app. Rebuild and reinstall the APK after changing env values.

Apply the SQL files under `supabase/migrations/` in order (Supabase SQL editor, or `supabase db push` if you've linked the CLI) to get the current schema: soft-delete columns, receipt/photo columns, the `transaction_items` line-item table, the `categories` table, and the statement-import tables.

## Architecture

```
src/
├── App.tsx            # Main screen: totals, category chart, payment list, settings
├── importPayments.ts  # Chase/Amex PDF + CSV statement parsers
├── ocr.ts              # Receipt OCR (tesseract.js) + image preprocessing
├── receipt.ts           # Capacitor Camera capture
├── categoriesApi.ts    # Category/sub-category CRUD against Supabase
├── categories.ts       # Category inference + chart bar-segment helpers
├── supabase.ts          # Supabase client + all transaction/statement queries
└── plugins/              # Capacitor bridge to native Android scanner/widget state

android/app/src/main/java/com/willhawe/spendtracker/
├── BankNotificationListener.java  # NotificationListenerService: parses payment alerts, tracks listener health
├── BankNotificationStore.java     # Classifies notifications, writes accepted payments via PaymentDao
├── AppDatabase.java / PaymentDao.java / PaymentEntity.java  # Room-backed durable payment queue
├── NotificationHealthStore.java   # Listener connect/disconnect state + rejection diagnostics log
├── SpentTodayWidget.java           # Daily spend total widget
├── MonthlyCategoryWidget.java      # Monthly category breakdown widget (Canvas chart)
├── CategoryBreakdownStore.java     # Cache the React app syncs widget data into
└── WidgetBridgePlugin.java          # Capacitor plugin bridging JS <-> native state
```

## Tech stack

| Layer | Choice | Why |
|-------|--------|-----|
| UI | React 19 + TypeScript | Fast to iterate, strong typing for domain model |
| Build | Vite | Instant dev server, easy phone testing on LAN |
| Native shell | Capacitor + Java | Notification listening and widgets need real Android APIs |
| Storage | Supabase (Postgres) | Managed Postgres with row-level security, reachable from the client with only a publishable key |
| Local cache | Android SharedPreferences | Instant widget refresh without a network round-trip |
| OCR | tesseract.js | Client-side receipt text extraction, no server required |
| Statement parsing | pdfjs-dist | Extract text layout from Chase/Amex PDF exports |
| Styling | Plain CSS | Mobile-first, no extra dependencies |

## Next steps

- Add duplicate handling across Wallet and bank-app notifications for the same payment.
- Broaden statement parsing beyond Chase/Amex PDF layouts.
- Surface reconciliation confidence (exact vs. fuzzy match) in the linking UI.

## Licence

MIT — see [LICENSE](LICENSE).
