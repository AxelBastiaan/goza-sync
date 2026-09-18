import { db } from "../db";
import { getShopeeStores, getTikTokStores } from "./storesRepo";
import { getShopeeOrderDetail, getShopeeOrderSummaries } from "./shopeeOrders";
import { getOrderDetail, getOrderStatus, OrderLineItem } from "./tiktokOrders";
import {
  createDeliveryOrder,
  createSalesInvoice,
  cancelOrder,
  reopenSalesOrder,
  resolveOrderLines,
  getShopeeCustomerId,
  getTikTokCustomerId,
} from "./accurateSalesFlow";
import { recordUnmappedSkus } from "./skuAlerts";

// Periodic safety net under the two order webhooks. Both marketplaces drop
// pushes — confirmed live on 2026-09-18: 17 Shopee orders from late August sat
// at "shipped" for weeks because their COMPLETED push never arrived, while
// orders from the same days invoiced fine. A webhook is a hint that something
// changed; this sweep is what makes the books converge even when the hint is
// lost. It re-reads the marketplace's real status for every order that is not
// yet at a terminal stage and pushes it through the same document creators the
// webhooks use, so there is one document-writing path, not two.
//
// It also repairs the one case where we did the wrong thing rather than nothing:
// an order we cancelled (SO closed, DO deleted) that the marketplace says was
// actually COMPLETED. That happened because Shopee's IN_CANCEL — a buyer's
// cancellation *request* — was treated as a cancellation; the seller rejected
// the request and the order went on to complete with money paid out.

type OrderStatus = "created" | "shipped" | "invoiced" | "cancelled";
const STAGE_ORDER: OrderStatus[] = ["created", "shipped", "invoiced"];

export interface ReconcileAction {
  platform: "shopee" | "tiktok";
  orderId: string;
  ours: OrderStatus;
  marketplace: string;
  action: string;
  result?: string;
  error?: string;
}

export interface ReconcileReport {
  checked: number;
  actions: ReconcileAction[];
  unchanged: number;
  dryRun: boolean;
}

interface OrderRow {
  key: string;
  sales_order_id: number | null;
  delivery_order_id: number | null;
  sales_invoice_id: number | null;
  status: OrderStatus;
  created_at: string;
}

// Shopee's own status enum → the stage our documents should be at. TO_RETURN /
// INVOICE_PENDING etc. deliberately map to nothing: a human call, not an
// automated push. IN_CANCEL is NOT a cancellation (see file comment).
function shopeeStage(status: string): OrderStatus | undefined {
  switch (status) {
    case "COMPLETED":
      return "invoiced";
    case "SHIPPED":
    case "TO_CONFIRM_RECEIVE":
      return "shipped";
    case "READY_TO_SHIP":
    case "PROCESSED":
    case "UNPAID":
    case "IN_CANCEL":
      return "created";
    case "CANCELLED":
      return "cancelled";
    default:
      return undefined;
  }
}

function tiktokStage(status: string | undefined): OrderStatus | undefined {
  switch (status) {
    case "DELIVERED":
    case "COMPLETED":
      return "invoiced";
    case "AWAITING_COLLECTION":
    case "IN_TRANSIT":
      return "shipped";
    case "UNPAID":
    case "ON_HOLD":
    case "AWAITING_SHIPMENT":
      return "created";
    case "CANCELLED":
      return "cancelled";
    default:
      return undefined;
  }
}

// Advances one order from its current row state to `target`, creating whatever
// documents are missing in between. Returns a description of what was written.
async function advance(
  platform: "shopee" | "tiktok",
  table: "shopee_orders" | "tiktok_orders",
  keyColumn: "order_sn" | "order_id",
  row: OrderRow,
  target: OrderStatus,
  lineItems: OrderLineItem[],
  createdAt: Date | undefined,
  customerId: number
): Promise<string> {
  const { unresolved } = await resolveOrderLines(lineItems);
  if (unresolved.length > 0) {
    recordUnmappedSkus(platform, row.key, unresolved);
    throw new Error(`blocked on unmapped SKU: ${unresolved.map((u) => u.sellerSku).join(", ")} — flagged on SKU Alerts`);
  }

  const written: string[] = [];
  const salesOrderId = row.sales_order_id!;
  let deliveryOrderId = row.delivery_order_id;
  let status = row.status;

  if (status === "cancelled") {
    // Wrongly cancelled: the SO was closed and the DO deleted. Reopen the SO so
    // the DO/SI can hang off the original document (keeps the SO-{id} number).
    await reopenSalesOrder(salesOrderId);
    written.push(`reopened SO ${salesOrderId}`);
    deliveryOrderId = null;
    status = "created";
  }

  if (status === "created" && STAGE_ORDER.indexOf(target) >= STAGE_ORDER.indexOf("shipped")) {
    deliveryOrderId = await createDeliveryOrder(row.key, salesOrderId, lineItems, customerId, createdAt);
    written.push(`DO ${deliveryOrderId}`);
    status = "shipped";
  }

  let salesInvoiceId: number | null = row.sales_invoice_id;
  if (status === "shipped" && target === "invoiced") {
    salesInvoiceId = await createSalesInvoice(row.key, salesOrderId, deliveryOrderId!, lineItems, customerId, createdAt);
    written.push(`SI ${salesInvoiceId}`);
    status = "invoiced";
  }

  db.prepare(`UPDATE ${table} SET delivery_order_id = ?, sales_invoice_id = ?, status = ? WHERE ${keyColumn} = ?`).run(
    deliveryOrderId,
    salesInvoiceId,
    status,
    row.key
  );

  return written.join(", ") || "nothing to write";
}

// Decides what (if anything) to do for one row given the marketplace's real
// stage. Returns undefined when the row is already where it should be.
function planAction(row: OrderRow, target: OrderStatus): string | undefined {
  if (row.status === "cancelled") {
    if (target === "cancelled" || target === "created") return undefined;
    return `wrongly cancelled — reopen SO and create DO${target === "invoiced" ? " + SI" : ""}`;
  }
  if (target === "cancelled") {
    return `cancel (close SO${row.delivery_order_id ? ", delete DO" : ""})`;
  }
  if (STAGE_ORDER.indexOf(target) > STAGE_ORDER.indexOf(row.status)) {
    return `advance ${row.status} → ${target}`;
  }
  return undefined;
}

export async function reconcileShopeeOrders(dryRun: boolean): Promise<ReconcileReport> {
  const stores = getShopeeStores();
  if (stores.length !== 1) {
    throw new Error(`Expected exactly one connected Shopee store, found ${stores.length}`);
  }
  const credentials = stores[0].credentials;
  const customerId = getShopeeCustomerId();

  const rows = db
    .prepare("SELECT order_sn AS key, sales_order_id, delivery_order_id, sales_invoice_id, status, created_at FROM shopee_orders WHERE status != 'invoiced'")
    .all() as OrderRow[];

  const summaries = await getShopeeOrderSummaries(
    rows.map((r) => r.key),
    credentials
  );
  const bySn = new Map(summaries.map((s) => [s.orderSn, s]));

  const report: ReconcileReport = { checked: rows.length, actions: [], unchanged: 0, dryRun };

  for (const row of rows) {
    const real = bySn.get(row.key)?.orderStatus ?? "UNKNOWN";
    const target = shopeeStage(real);
    const entry: ReconcileAction = { platform: "shopee", orderId: row.key, ours: row.status, marketplace: real, action: "" };

    if (!target) {
      entry.action = "needs manual review (status not automated)";
      report.actions.push(entry);
      continue;
    }

    const action = planAction(row, target);
    if (!action) {
      report.unchanged++;
      continue;
    }
    entry.action = action;

    if (dryRun) {
      report.actions.push(entry);
      continue;
    }

    try {
      if (target === "cancelled") {
        await cancelOrder(row.sales_order_id!, row.delivery_order_id);
        db.prepare("UPDATE shopee_orders SET status = 'cancelled' WHERE order_sn = ?").run(row.key);
        entry.result = "cancelled";
      } else {
        const detail = await getShopeeOrderDetail(row.key, credentials);
        if (detail.lineItems.length === 0) throw new Error("Shopee returned no line items");
        entry.result = await advance("shopee", "shopee_orders", "order_sn", row, target, detail.lineItems, detail.createdAt, customerId);
      }
      console.log(`[reconcile] shopee ${row.key}: ${entry.action} → ${entry.result}`);
    } catch (err: any) {
      entry.error = err?.message ?? String(err);
      console.error(`[reconcile] shopee ${row.key} failed: ${entry.error}`);
    }
    report.actions.push(entry);
  }

  return report;
}

export async function reconcileTikTokOrders(dryRun: boolean): Promise<ReconcileReport> {
  const stores = getTikTokStores();
  if (stores.length !== 1) {
    throw new Error(`Expected exactly one connected TikTok store, found ${stores.length}`);
  }
  const credentials = stores[0].credentials;
  const customerId = getTikTokCustomerId();

  const rows = db
    .prepare("SELECT order_id AS key, sales_order_id, delivery_order_id, sales_invoice_id, status, created_at FROM tiktok_orders WHERE status != 'invoiced'")
    .all() as OrderRow[];

  const report: ReconcileReport = { checked: rows.length, actions: [], unchanged: 0, dryRun };

  for (const row of rows) {
    const real = (await getOrderStatus(row.key, credentials)) ?? "UNKNOWN";
    const target = tiktokStage(real);
    const entry: ReconcileAction = { platform: "tiktok", orderId: row.key, ours: row.status, marketplace: real, action: "" };

    if (!target) {
      entry.action = "needs manual review (status not automated)";
      report.actions.push(entry);
      continue;
    }

    const action = planAction(row, target);
    if (!action) {
      report.unchanged++;
      continue;
    }
    entry.action = action;

    if (dryRun) {
      report.actions.push(entry);
      continue;
    }

    try {
      if (target === "cancelled") {
        await cancelOrder(row.sales_order_id!, row.delivery_order_id);
        db.prepare("UPDATE tiktok_orders SET status = 'cancelled' WHERE order_id = ?").run(row.key);
        entry.result = "cancelled";
      } else {
        const detail = await getOrderDetail(row.key, credentials);
        if (detail.lineItems.length === 0) throw new Error("TikTok returned no line items");
        entry.result = await advance("tiktok", "tiktok_orders", "order_id", row, target, detail.lineItems, detail.createdAt, customerId);
      }
      console.log(`[reconcile] tiktok ${row.key}: ${entry.action} → ${entry.result}`);
    } catch (err: any) {
      entry.error = err?.message ?? String(err);
      console.error(`[reconcile] tiktok ${row.key} failed: ${entry.error}`);
    }
    report.actions.push(entry);
  }

  return report;
}

// Runs both sweeps, never throwing — a scheduled job must not take the server
// down because one marketplace's API happened to be unreachable.
export async function reconcileAllOrders(): Promise<void> {
  const sweeps: [string, (dryRun: boolean) => Promise<ReconcileReport>][] = [
    ["shopee", reconcileShopeeOrders],
    ["tiktok", reconcileTikTokOrders],
  ];
  for (const [name, fn] of sweeps) {
    try {
      const report = await fn(false);
      const failed = report.actions.filter((a) => a.error).length;
      console.log(
        `[reconcile] ${name}: checked ${report.checked}, acted on ${report.actions.length - failed}, failed ${failed}, unchanged ${report.unchanged}`
      );
    } catch (err: any) {
      console.error(`[reconcile] ${name} sweep failed:`, err?.message ?? err);
    }
  }
}
