// One-off repair for the two failure classes the reconciliation sweep can't fix
// on its own, run by hand with the owner's explicit go-ahead (2026-09-18):
//
//   rebuild  — the order's SO/DO were written while some of its SKUs were still
//              unmapped and got silently dropped, so the documents are short and
//              no invoice can be hung off them. Delete the short document(s),
//              recreate them complete from today's resolution, then invoice.
//   dedupe   — the order already has a manually-entered, paid invoice from before
//              automation; our SO+DO are duplicates and the DO is decrementing
//              stock a second time. Delete both and point the row at the real
//              invoice so the sweep stops retrying it.
//
//   node dist/scripts/repairOrders.js rebuild shopee 2608234WETPUQ6
//   node dist/scripts/repairOrders.js dedupe  tiktok 585513281916339433 337902
import { db } from "../db";
import { callAccurateApi } from "../services/accurateClient";
import { getShopeeStores, getTikTokStores } from "../services/storesRepo";
import { getShopeeOrderDetail } from "../services/shopeeOrders";
import { getOrderDetail } from "../services/tiktokOrders";
import {
  createSalesOrder,
  createDeliveryOrder,
  createSalesInvoice,
  resolveOrderLines,
  getShopeeCustomerId,
  getTikTokCustomerId,
} from "../services/accurateSalesFlow";

type Platform = "shopee" | "tiktok";

interface Row {
  sales_order_id: number | null;
  delivery_order_id: number | null;
  sales_invoice_id: number | null;
  status: string;
}

function table(platform: Platform): { name: string; key: string } {
  return platform === "shopee" ? { name: "shopee_orders", key: "order_sn" } : { name: "tiktok_orders", key: "order_id" };
}

function getRow(platform: Platform, orderId: string): Row {
  const t = table(platform);
  const row = db.prepare(`SELECT * FROM ${t.name} WHERE ${t.key} = ?`).get(orderId) as Row | undefined;
  if (!row) throw new Error(`${platform} order ${orderId} is not on file`);
  return row;
}

async function deleteDoc(kind: "delivery-order" | "sales-order", id: number): Promise<void> {
  const r = await callAccurateApi("POST", `${kind}/delete.do`, { id });
  if (!r.data?.s) throw new Error(`${kind}/delete.do failed for ${id}: ${JSON.stringify(r.data?.d ?? r.status)}`);
  console.log(`  deleted ${kind} ${id}`);
}

async function lineCount(kind: "delivery-order" | "sales-order", id: number): Promise<number> {
  const r = await callAccurateApi("GET", `${kind}/detail.do`, { id });
  if (!r.data?.s) throw new Error(`${kind}/detail.do failed for ${id}: ${JSON.stringify(r.data?.d ?? r.status)}`);
  return (r.data?.d?.detailItem ?? []).length;
}

async function fetchOrder(platform: Platform, orderId: string) {
  if (platform === "shopee") {
    const store = getShopeeStores()[0];
    return getShopeeOrderDetail(orderId, store.credentials);
  }
  const store = getTikTokStores()[0];
  return getOrderDetail(orderId, store.credentials);
}

async function rebuild(platform: Platform, orderId: string): Promise<void> {
  const row = getRow(platform, orderId);
  if (row.sales_invoice_id) throw new Error(`${orderId} already has SI ${row.sales_invoice_id} — nothing to rebuild`);
  const customerId = platform === "shopee" ? getShopeeCustomerId() : getTikTokCustomerId();

  const detail = await fetchOrder(platform, orderId);
  const { details, unresolved } = await resolveOrderLines(detail.lineItems);
  if (unresolved.length > 0) throw new Error(`still unmapped: ${unresolved.map((u) => u.sellerSku).join(", ")}`);
  const expected = details.length;
  console.log(`${orderId}: ${expected} line(s) resolve today; SO ${row.sales_order_id}, DO ${row.delivery_order_id}`);

  let salesOrderId = row.sales_order_id!;
  if (row.delivery_order_id) {
    await deleteDoc("delivery-order", row.delivery_order_id);
  }
  const soLines = await lineCount("sales-order", salesOrderId);
  if (soLines !== expected) {
    console.log(`  SO ${salesOrderId} is short too (${soLines} of ${expected}) — replacing it`);
    await deleteDoc("sales-order", salesOrderId);
    salesOrderId = (await createSalesOrder(orderId, detail.lineItems, customerId, detail.createdAt)).salesOrderId;
    console.log(`  created SO ${salesOrderId}`);
  }

  const deliveryOrderId = await createDeliveryOrder(orderId, salesOrderId, detail.lineItems, customerId, detail.createdAt);
  console.log(`  created DO ${deliveryOrderId}`);
  const salesInvoiceId = await createSalesInvoice(orderId, salesOrderId, deliveryOrderId, detail.lineItems, customerId, detail.createdAt);
  console.log(`  created SI ${salesInvoiceId}`);

  const t = table(platform);
  db.prepare(`UPDATE ${t.name} SET sales_order_id = ?, delivery_order_id = ?, sales_invoice_id = ?, status = 'invoiced' WHERE ${t.key} = ?`).run(
    salesOrderId,
    deliveryOrderId,
    salesInvoiceId,
    orderId
  );
  console.log(`  row updated: SO ${salesOrderId} / DO ${deliveryOrderId} / SI ${salesInvoiceId}`);
}

async function dedupe(platform: Platform, orderId: string, existingInvoiceId: number): Promise<void> {
  const row = getRow(platform, orderId);
  if (row.sales_invoice_id) throw new Error(`${orderId} already points at SI ${row.sales_invoice_id}`);

  // Confirm the invoice we're deferring to really carries this order's number.
  const r = await callAccurateApi("GET", "sales-invoice/detail.do", { id: existingInvoiceId });
  if (!r.data?.s) throw new Error(`sales-invoice/detail.do failed for ${existingInvoiceId}`);
  if (String(r.data.d?.number).toUpperCase() !== orderId.toUpperCase()) {
    throw new Error(`SI ${existingInvoiceId} is numbered ${r.data.d?.number}, not ${orderId} — refusing`);
  }
  console.log(`${orderId}: existing SI ${existingInvoiceId} (${r.data.d?.transDate}, ${r.data.d?.statusName}) confirmed; removing our SO ${row.sales_order_id} / DO ${row.delivery_order_id}`);

  if (row.delivery_order_id) await deleteDoc("delivery-order", row.delivery_order_id);
  if (row.sales_order_id) await deleteDoc("sales-order", row.sales_order_id);

  const t = table(platform);
  db.prepare(`UPDATE ${t.name} SET sales_order_id = NULL, delivery_order_id = NULL, sales_invoice_id = ?, status = 'invoiced' WHERE ${t.key} = ?`).run(
    existingInvoiceId,
    orderId
  );
  console.log(`  row now points at SI ${existingInvoiceId}`);
}

async function main(): Promise<void> {
  const [cmd, platform, orderId, siId] = process.argv.slice(2);
  if (platform !== "shopee" && platform !== "tiktok") throw new Error("platform must be shopee|tiktok");
  if (cmd === "rebuild" && orderId) return rebuild(platform, orderId);
  if (cmd === "dedupe" && orderId && siId) return dedupe(platform, orderId, Number(siId));
  throw new Error("usage: rebuild <platform> <orderId> | dedupe <platform> <orderId> <existingSiId>");
}

main().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
