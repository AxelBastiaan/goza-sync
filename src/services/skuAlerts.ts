import { db } from "../db";
import { getMappingForMarketplaceSku } from "./skuMappings";

// An order line that couldn't be turned into an Accurate document line. Produced
// by accurateSalesFlow.resolveOrderLines() and recorded here so a missing mapping
// surfaces in the UI instead of only in a webhook's error log.
export interface UnresolvedOrderLine {
  sellerSku: string;
  productName?: string;
  variantName?: string;
  reason: string;
}

export interface SkuAlert {
  id: number;
  platform: string;
  marketplaceSku: string;
  productTitle: string | null;
  variantName: string | null;
  reason: string;
  blockedOrders: string[];
  occurrenceCount: number;
  status: "open" | "resolved" | "ignored";
  firstSeenAt: string;
  lastSeenAt: string;
  // Not stored — recomputed on read, so a mapping added on the Product Mapping
  // page immediately shows here without any cross-page bookkeeping.
  mappedNow: boolean;
}

interface SkuAlertRow {
  id: number;
  platform: string;
  marketplace_sku: string;
  product_title: string | null;
  variant_name: string | null;
  reason: string;
  blocked_orders_json: string;
  occurrence_count: number;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
}

function rowToAlert(row: SkuAlertRow): SkuAlert {
  let blockedOrders: string[] = [];
  try {
    const parsed = JSON.parse(row.blocked_orders_json);
    if (Array.isArray(parsed)) blockedOrders = parsed.filter((o): o is string => typeof o === "string");
  } catch {
    // A corrupt blob shouldn't hide the alert itself — the SKU and reason are
    // what someone acts on; the order list is supporting detail.
  }

  return {
    id: row.id,
    platform: row.platform,
    marketplaceSku: row.marketplace_sku,
    productTitle: row.product_title,
    variantName: row.variant_name,
    reason: row.reason,
    blockedOrders,
    occurrenceCount: row.occurrence_count,
    status: row.status as SkuAlert["status"],
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    mappedNow: Boolean(getMappingForMarketplaceSku(row.marketplace_sku)),
  };
}

// Records every unresolved line of one order, one row per (platform, SKU). A SKU
// that blocks twenty orders stays a single row to act on; the order ids accumulate
// in blocked_orders_json so they can be backfilled once the mapping exists.
//
// An existing row is always reopened (status back to 'open'), even if it had been
// resolved or ignored: a new order arriving on a SKU nobody mapped is new evidence,
// and silently leaving it dismissed is exactly the silence this table exists to end.
export function recordUnmappedSkus(platform: string, orderId: string, lines: UnresolvedOrderLine[]): void {
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT INTO unmapped_sku_alerts
      (platform, marketplace_sku, product_title, variant_name, reason, blocked_orders_json, occurrence_count, status, first_seen_at, last_seen_at)
    VALUES (@platform, @sku, @title, @variant, @reason, @orders, 1, 'open', @now, @now)
    ON CONFLICT (platform, marketplace_sku) DO UPDATE SET
      product_title   = COALESCE(excluded.product_title, product_title),
      variant_name    = COALESCE(excluded.variant_name, variant_name),
      reason          = excluded.reason,
      status          = 'open',
      last_seen_at    = excluded.last_seen_at
  `);

  const readOrders = db.prepare("SELECT blocked_orders_json FROM unmapped_sku_alerts WHERE platform = ? AND marketplace_sku = ?");
  const writeOrders = db.prepare(
    "UPDATE unmapped_sku_alerts SET blocked_orders_json = ?, occurrence_count = ? WHERE platform = ? AND marketplace_sku = ?"
  );

  const run = db.transaction((rows: UnresolvedOrderLine[]) => {
    for (const line of rows) {
      insert.run({
        platform,
        sku: line.sellerSku,
        title: line.productName ?? null,
        variant: line.variantName ?? null,
        reason: line.reason,
        orders: JSON.stringify([orderId]),
        now,
      });

      const existing = readOrders.get(platform, line.sellerSku) as { blocked_orders_json: string } | undefined;
      let orders: string[] = [];
      try {
        orders = JSON.parse(existing?.blocked_orders_json ?? "[]");
      } catch {
        orders = [];
      }
      if (!orders.includes(orderId)) orders.push(orderId);
      // Keep the list bounded — the first 200 blocked orders are more than enough
      // to act on, and an unnoticed alert shouldn't grow a row without limit.
      writeOrders.run(JSON.stringify(orders.slice(0, 200)), orders.length, platform, line.sellerSku);
    }
  });

  run(lines);
}

// Rows whose SKU has since been mapped are flipped to 'resolved' on read, so the
// list reflects reality without anyone having to remember to come back and tick
// something off after adding the mapping.
export function listSkuAlerts(): SkuAlert[] {
  const rows = db
    .prepare("SELECT * FROM unmapped_sku_alerts ORDER BY status = 'open' DESC, last_seen_at DESC")
    .all() as SkuAlertRow[];

  const alerts = rows.map(rowToAlert);

  const resolve = db.prepare("UPDATE unmapped_sku_alerts SET status = 'resolved' WHERE id = ?");
  for (const alert of alerts) {
    if (alert.status === "open" && alert.mappedNow) {
      resolve.run(alert.id);
      alert.status = "resolved";
    }
  }

  return alerts;
}

export function countOpenSkuAlerts(): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM unmapped_sku_alerts WHERE status = 'open'").get() as { n: number };
  return row.n;
}

export function setSkuAlertStatus(id: number, status: SkuAlert["status"]): boolean {
  const result = db.prepare("UPDATE unmapped_sku_alerts SET status = ? WHERE id = ?").run(status, id);
  return result.changes > 0;
}

export function deleteSkuAlert(id: number): boolean {
  return db.prepare("DELETE FROM unmapped_sku_alerts WHERE id = ?").run(id).changes > 0;
}
