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
