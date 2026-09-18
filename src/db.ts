import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { getEnv } from "./env";

const DATA_DIR = path.resolve(__dirname, "..", "data");
const DB_PATH = path.join(DATA_DIR, "gozasync.db");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const db = new Database(DB_PATH);

// Maps a generic marketplace SKU (the same SKU string is looked up across every
// connected store, regardless of platform) to an Accurate item + which of Accurate's
// own configured unit levels (1/2/3 = unit1/unit2/unit3) it represents. One Accurate
// SKU can appear in many rows (e.g. separate "per PC"/"per PAK"/"per CTN" listings
// for the same physical item) — accurate_sku is intentionally NOT unique.
// marketplace_sku is nullable (a mapping "slot" can exist with no active SKU, e.g.
// temporarily disabled) — SQLite's UNIQUE allows multiple NULLs, so this doesn't
// conflict. is_default marks the auto-created PCS row that every Accurate SKU gets
// on first add; it's just a display badge now — it used to block deletion, but that
// restriction was dropped since the accordion header already shows base stock.
db.exec(`
  CREATE TABLE IF NOT EXISTS sku_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    accurate_sku TEXT NOT NULL,
    unit_level INTEGER NOT NULL,
    marketplace_sku TEXT UNIQUE,
    is_default INTEGER NOT NULL DEFAULT 0
  )
`);

// Guarded rename: sku_mappings used to be TikTok-specific (tiktok_sku). Now that a
// mapping's SKU is checked across every connected store regardless of platform, the
// column is renamed to marketplace_sku. Only runs once — no-op on every later boot.
const skuMappingsColumns = db.prepare("PRAGMA table_info(sku_mappings)").all() as { name: string }[];
const hasOldTiktokSkuColumn = skuMappingsColumns.some((c) => c.name === "tiktok_sku");
const hasNewMarketplaceSkuColumn = skuMappingsColumns.some((c) => c.name === "marketplace_sku");
if (hasOldTiktokSkuColumn && !hasNewMarketplaceSkuColumn) {
  db.exec(`ALTER TABLE sku_mappings RENAME COLUMN tiktok_sku TO marketplace_sku`);
}

// Registry of connected marketplace stores, shown in the "N stores" popup on each
// mapping row and on the Integrations page. A platform can have more than one store
// (e.g. two TikTok shops authorized under the same Partner Center app) — each row
// carries its OWN credentials, since access tokens are per-shop, not per-platform.
// credentials is a JSON blob whose shape depends on platform:
//   tiktok: { accessToken, refreshToken, shopCipher }
//   shopee: { accessToken, refreshToken, shopId }
// platform_shop_id is the platform's own shop identifier, used to dedupe re-auth of
// an already-connected shop (upsert, not a new row) — nullable for legacy rows.
db.exec(`
  CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    name TEXT NOT NULL
  )
`);

const storesColumns = db.prepare("PRAGMA table_info(stores)").all() as { name: string }[];
if (!storesColumns.some((c) => c.name === "credentials")) {
  db.exec(`ALTER TABLE stores ADD COLUMN credentials TEXT`);
}
if (!storesColumns.some((c) => c.name === "platform_shop_id")) {
  db.exec(`ALTER TABLE stores ADD COLUMN platform_shop_id TEXT`);
}

// One-time backfill: earlier versions of this table auto-seeded one empty
// placeholder row per platform (no credentials) before real per-store credentials
// existed. If a tiktok placeholder is sitting on top of a real, working global
// connection in .env, fold that connection into the row so it isn't lost; any
// placeholder left with no credentials afterward (e.g. the old Shopee placeholder,
// since Shopee isn't connected yet) is deleted — stores are only created via a real
// completed OAuth flow from here on.
const placeholderTiktokStore = db
  .prepare("SELECT id FROM stores WHERE platform = 'tiktok' AND credentials IS NULL")
  .get() as { id: number } | undefined;
if (placeholderTiktokStore) {
  const accessToken = getEnv("ACCESS_TOKEN");
  const shopCipher = getEnv("SHOP_CIPHER");
  const refreshToken = getEnv("REFRESH_TOKEN");
  if (accessToken && shopCipher) {
    db.prepare("UPDATE stores SET credentials = ? WHERE id = ?").run(
      JSON.stringify({ accessToken, refreshToken, shopCipher }),
      placeholderTiktokStore.id
    );
  }
}
db.exec(`DELETE FROM stores WHERE credentials IS NULL`);

// Tracks each TikTok order's Accurate document lifecycle:
// 'created' = Sales Order only. 'shipped' = SO+Delivery Order (stock decremented).
// 'invoiced' = SO+DO+Sales Invoice. 'cancelled' = SO closed (+ DO deleted if one existed).
db.exec(`
  CREATE TABLE IF NOT EXISTS tiktok_orders (
    order_id TEXT PRIMARY KEY,
    sales_order_id INTEGER,
    delivery_order_id INTEGER,
    sales_invoice_id INTEGER,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

// Same shape/lifecycle as tiktok_orders, kept as a separate table (rather than a
// shared one keyed loosely by order id) since the two platforms' order-id formats
// aren't guaranteed disjoint and the semantics are platform-specific enough to want
// clean separation.
db.exec(`
  CREATE TABLE IF NOT EXISTS shopee_orders (
    order_sn TEXT PRIMARY KEY,
    sales_order_id INTEGER,
    delivery_order_id INTEGER,
    sales_invoice_id INTEGER,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

// Generic key-value store for app-wide toggles, e.g. "live_mode".
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

// password_hash stores "salt:hash" (both hex) — scrypt, not bcrypt, to avoid
// pulling in a native dependency beyond the one better-sqlite3 already requires.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

// stock_reservations existed as a workaround for the gap between a Sales Order
// (zero stock effect) and its Delivery Order (real decrement). Superseded by reading
// Accurate's own `availableToSell` field directly, which nets out every open Sales
// Order authoritatively and in real time — no local bookkeeping needed. Dropped here
// rather than left as unused dead schema.
db.exec(`DROP TABLE IF EXISTS stock_reservations`);

// One row per active SKU ever queued into the daily stock-opname rotation.
// released_date is set once the item is pulled into the worker's daily list;
// completed_date is set when the worker marks it done. Both NULL = still waiting
// in the queue. Rows are never deleted, so a completed/released history persists
// across yearly cycle rollovers.
db.exec(`
  CREATE TABLE IF NOT EXISTS stock_opname_items (
    sku TEXT PRIMARY KEY,
    item_name TEXT NOT NULL,
    released_date TEXT,
    completed_date TEXT
  )
`);

// Single row (id=1) tracking the current yearly rotation: which year it covers,
// the daily batch size computed for that year (active item count / work days in
// the year), the ordered queue of SKUs not yet released this year, and the last
// date a batch was released — so a batch is only released once per work day no
// matter how many times the stock-opname tab is opened that day.
db.exec(`
  CREATE TABLE IF NOT EXISTS stock_opname_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cycle_year INTEGER NOT NULL,
    batch_size INTEGER NOT NULL,
    queue_json TEXT NOT NULL,
    last_release_date TEXT
  )
`);

// Cached per-year Indonesian public holiday ("tanggal merah") dates, so the
// holiday API is only called once per year instead of on every request.
db.exec(`
  CREATE TABLE IF NOT EXISTS stock_opname_holidays (
    year INTEGER NOT NULL,
    date TEXT NOT NULL,
    name TEXT,
    PRIMARY KEY (year, date)
  )
`);

// One row per marketplace SKU that an order referenced but that couldn't be
// resolved to an Accurate item. Orders containing one are refused outright (see
// toAccurateDetailItems) rather than booked short, so this table is what makes
// that refusal visible instead of silent — it's the queue of "orders we can't
// book until someone maps this SKU".
//
// Keyed per (platform, marketplace_sku) so a SKU that blocks twenty orders is one
// row to act on, not twenty; blocked_orders_json keeps the affected order ids so
// they can be backfilled once the mapping exists. product_title is stored because
// that is what actually lets a human work out the intended SKU (a real case was
// resolved purely from the variant name "CAMPUS MERAH").
db.exec(`
  CREATE TABLE IF NOT EXISTS unmapped_sku_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    marketplace_sku TEXT NOT NULL,
    product_title TEXT,
    variant_name TEXT,
    reason TEXT NOT NULL,
    blocked_orders_json TEXT NOT NULL DEFAULT '[]',
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'open',
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    UNIQUE (platform, marketplace_sku)
  )
`);

// ---- Invoice reminders (overdue piutang → WhatsApp reminders the admin sends) ----

// One row per overdue, unpaid sales invoice seen in Accurate (non-marketplace
// customers only). Accurate stays the source of truth for amounts/payment — this
// table only adds the reminder bookkeeping on top:
// - effective_due_date is the date the +3/+7/+10/+14 schedule counts from. It
//   equals due_date for invoices that go overdue while the feature is live; for
//   the backlog that was already overdue at go-live it's shifted so the cycle
//   starts from scratch (spread over the first working days), and it stays NULL
//   until the feature goes live, which keeps everything out of the queues.
// - stage_sent = how many of the three customer reminders this invoice has been
//   covered by (0-3).
// - escalated_at = the day it was handed to the salesperson (+14); customer
//   reminders stop for it after that.
// - paid_at = the first refresh that no longer saw it as outstanding+overdue in
//   Accurate (paid, or its due date was moved). It reappears (paid_at cleared) if
//   Accurate lists it again.
// dpp/tax/payment_term/salesman_name come from sales-invoice/detail.do and are
// refreshed together with the cached lines (detail_fetched_date).
db.exec(`
  CREATE TABLE IF NOT EXISTS invoice_reminder_invoices (
    invoice_id INTEGER PRIMARY KEY,
    number TEXT NOT NULL,
    customer_id INTEGER NOT NULL,
    trans_date TEXT NOT NULL,
    due_date TEXT NOT NULL,
    effective_due_date TEXT,
    total_amount REAL NOT NULL,
    prime_owing REAL NOT NULL,
    stage_sent INTEGER NOT NULL DEFAULT 0,
    escalated_at TEXT,
    paid_at TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    dpp_amount REAL,
    tax_amount REAL,
    payment_term TEXT,
    salesman_name TEXT,
    detail_fetched_date TEXT
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_invoice_reminder_invoices_customer ON invoice_reminder_invoices (customer_id)`);

// Line items per invoice for the letter's attachment pages, cached from
// sales-invoice/detail.do (refetched at most once per day per invoice).
db.exec(`
  CREATE TABLE IF NOT EXISTS invoice_reminder_lines (
    invoice_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    item_no TEXT,
    item_name TEXT,
    quantity REAL,
    unit TEXT,
    unit_price REAL,
    disc_percent TEXT,
    cash_discount REAL,
    total_price REAL,
    PRIMARY KEY (invoice_id, seq)
  )
`);

// Customer contact data from customer/detail.do. phone is the raw Accurate value
// (can be messy, e.g. "081392834404 WA") — the WhatsApp number is derived from it
// at use time. ignored = the admin chose to never remind this customer (related
// party, special arrangement, disputed); review_note = why it was flagged for a
// look before go-live.
db.exec(`
  CREATE TABLE IF NOT EXISTS invoice_reminder_customers (
    customer_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    customer_no TEXT,
    contact_name TEXT,
    phone TEXT,
    salesman_id INTEGER,
    ignored INTEGER NOT NULL DEFAULT 0,
    ignored_note TEXT,
    review_note TEXT,
    fetched_at TEXT
  )
`);

// Salespeople the +14 hand-off goes to, with the Accurate salesman ids that map
// to them (a person can have more than one id). Seeded once below; their WhatsApp
// numbers are entered from the Invoice Reminders tab ("Salespeople") and live
// only in the database — this repo is public, so personal numbers never go in code.
db.exec(`
  CREATE TABLE IF NOT EXISTS invoice_reminder_salespeople (
    name TEXT PRIMARY KEY,
    salesman_ids TEXT NOT NULL,
    phone TEXT
  )
`);
{
  const seed = db.prepare("INSERT OR IGNORE INTO invoice_reminder_salespeople (name, salesman_ids) VALUES (?, ?)");
  // Ids mirror sales-recall/services/salesConfig.ts.
  seed.run("HODORI", "[152]");
  seed.run("RICKYANTO", "[153,53200]");
  seed.run("SHIVA", "[53951]");
  seed.run("SOETRISNO", "[102]");
  seed.run("TEDDY", "[157]");
  seed.run("YOYOK", "[151]");
}

// Every reminder the admin marked as sent (kind='customer') and every hand-off to
// a salesperson (kind='sales'). The latest non-undone customer row is what the
// 3-day gap is measured from. snapshot holds the per-invoice state from just
// before the action, so Undo can put it back exactly.
db.exec(`
  CREATE TABLE IF NOT EXISTS invoice_reminder_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    customer_id INTEGER,
    salesperson TEXT,
    stage INTEGER,
    letter_no TEXT,
    invoice_ids TEXT NOT NULL,
    total_owing REAL,
    snapshot TEXT NOT NULL,
    sent_by TEXT,
    sent_at TEXT NOT NULL,
    sent_date TEXT NOT NULL,
    undone_at TEXT
  )
`);

// JT-YYMM#### letter numbers: one per PDF produced, counting up from 0001 each
// month. A re-download of the same customer's letter on the same day (same
// invoices) reuses its number instead of burning a new one.
db.exec(`
  CREATE TABLE IF NOT EXISTS invoice_reminder_letters (
    letter_no TEXT PRIMARY KEY,
    customer_id INTEGER NOT NULL,
    issued_date TEXT NOT NULL,
    invoice_ids TEXT NOT NULL
  )
`);
