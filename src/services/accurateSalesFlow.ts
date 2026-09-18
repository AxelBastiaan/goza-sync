import { getEnv } from "../env";
import { callAccurateApi } from "./accurateClient";
import { getDefaultWarehouseId, formatAccurateDate } from "./accurateAdjustment";
import { fetchAccurateItemDataFor } from "./stockSync";
import { getMappingForMarketplaceSku } from "./skuMappings";
import { OrderLineItem } from "./tiktokOrders";
import { UnresolvedOrderLine } from "./skuAlerts";

// NOTE: everything in this file writes real Sales Order / Delivery Order / Sales
// Invoice documents into Accurate's live books. Field names for the *write* (save.do)
// request bodies are inferred from item-adjustment/save.do's confirmed flat-itemNo
// convention and from real detail.do RESPONSE shapes inspected live — the request
// shape itself is unconfirmed until the first live save.do call succeeds or fails.
// Treat the first real use of each function as a calibration test, not a sure thing.

export function getTikTokCustomerId(): number {
  const id = getEnv("ACCURATE_TIKTOK_CUSTOMER_ID");
  if (!id) {
    throw new Error("ACCURATE_TIKTOK_CUSTOMER_ID is not set in .env");
  }
  return Number(id);
}

// Separate Accurate customer record from TikTok's — orders from different
// marketplaces must not get attributed to the same customer, or revenue reporting
// per channel becomes meaningless. Confirmed against the real customer list
// (id 87450, "Shopee Goza Indonesia") rather than guessed.
export function getShopeeCustomerId(): number {
  const id = getEnv("ACCURATE_SHOPEE_CUSTOMER_ID");
  if (!id) {
    throw new Error("ACCURATE_SHOPEE_CUSTOMER_ID is not set in .env");
  }
  return Number(id);
}

// Fetches a document's detail rows in creation order (by seq, falling back to id).
// Needed because when an order has two lines mapped to the same Accurate SKU (e.g.
// separate PAK and CTN listings both backed by the same item), bare itemNo matching
// is ambiguous — Accurate can attach a Delivery Order or Sales Invoice line to the
// wrong Sales Order/Delivery Order detail row, silently miscomparing shipped vs.
// invoiced quantities. Confirmed live: a two-line same-SKU order failed invoicing
// with "quantity exceeds shipped" even with no concurrency involved, because our
// request only sent itemNo/quantity, not which specific detail row each applied to.
//
// Both endpoints' detail rows are derived, in order, from the exact same lineItems
// array via toAccurateDetailItems (same filtering, same order) as the document being
// inspected was created with — so as long as SKU mappings haven't changed since then,
// zipping by position correctly disambiguates repeated itemNos.
// Accurate renders transDate as dd/MM/yyyy (Jakarta calendar date). Parsed to
// midday Jakarta so a later formatAccurateDate() round-trips to the same day.
function parseAccurateDate(value: string): Date | undefined {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value ?? "");
  if (!m) return undefined;
  return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), 5, 0, 0));
}

// Accurate refuses a document dated before its parent ("Tanggal Faktur
// Penjualan mendahului Tanggal Pengiriman Pesanan"). The order's own placement
// date is the right date for every document — but when a parent was created
// late (a Delivery Order written days after the sale, from a delayed webhook,
// and dated on arrival), the child cannot go earlier than it. Later of the two
// is the closest legal date; the alternative, failing, leaves the order with no
// invoice at all — which is how 22 orders got stuck on 2026-09-18.
function notBefore(requested: Date, parent: Date | undefined): Date {
  return parent && parent.getTime() > requested.getTime() ? parent : requested;
}

async function fetchSalesOrderDetailIds(salesOrderId: number): Promise<{ detailIds: number[]; transDate: Date | undefined }> {
  const response = await callAccurateApi("GET", "sales-order/detail.do", { id: salesOrderId });
  if (!response.data?.s) {
    throw new Error(`Accurate sales-order/detail.do failed for SO ${salesOrderId}: ${JSON.stringify(response.data?.d ?? response.status)}`);
  }

  const items = (response.data?.d?.detailItem ?? []) as { id: number; seq?: number }[];
  return {
    detailIds: items
      .slice()
      .sort((a, b) => (a.seq ?? a.id) - (b.seq ?? b.id))
      .map((item) => item.id),
    transDate: parseAccurateDate(response.data?.d?.transDate),
  };
}

async function fetchDeliveryOrderDetailRows(
  deliveryOrderId: number
): Promise<{ rows: { id: number; salesOrderDetailId: number }[]; transDate: Date | undefined }> {
  const response = await callAccurateApi("GET", "delivery-order/detail.do", { id: deliveryOrderId });
  if (!response.data?.s) {
    throw new Error(`Accurate delivery-order/detail.do failed for DO ${deliveryOrderId}: ${JSON.stringify(response.data?.d ?? response.status)}`);
  }

  const items = (response.data?.d?.detailItem ?? []) as { id: number; seq?: number; salesOrderDetailId: number }[];
  return {
    rows: items
      .slice()
      .sort((a, b) => (a.seq ?? a.id) - (b.seq ?? b.id))
      .map((item) => ({ id: item.id, salesOrderDetailId: item.salesOrderDetailId })),
    transDate: parseAccurateDate(response.data?.d?.transDate),
  };
}

// Converts marketplace order lines into Accurate detail lines, applying each
// line's mapped unit ratio: quantity is multiplied by the ratio (a "1 PAK" order
// becomes "10 PCS" in Accurate's base unit). unitPrice is set to the marketplace's
// own pre-promotion listed price (line.originalPrice) — this is the "before
// discount" gross value the user asked to show on these documents, sourced from
// the actual listing's promotion rather than Accurate's own (potentially stale)
// item price. itemCashDiscount then carries the gap between that gross value and
// what the marketplace actually charged (confirmed live: itemCashDiscount is a
// flat amount subtracted from the line total, e.g. qty 10 * unitPrice 1135 with
// itemCashDiscount 500 -> totalPrice 10850). For TikTok this reduces to exactly
// the seller-funded discount (original_price - (original_price - seller_discount)
// = seller_discount), which is the cleanest possible outcome. Can come out
// negative if a listing's "original" price on file is below what was actually
// charged — the field accepts that the same way, since it's a plain subtraction;
// the total transaction value is preserved exactly regardless of direction.
//
// A line that can't be resolved (no SKU mapping, or the mapped Accurate item has
// no such unit level) aborts the whole document rather than being skipped.
// Skipping used to be the behaviour and it silently under-invoiced: one real order
// booked Rp26,400 instead of Rp270,000 because 7 of its 8 lines were unmapped at
// the time, and nothing anywhere reported it. A missing document is recoverable
// (the mapping gets added, then the order is backfilled); a document that is
// quietly short by most of its value is not, because nobody knows to look.
export interface AccurateDetailItem {
  itemNo: string;
  quantity: number;
  unitPrice: number;
  itemCashDiscount: number;
}

export interface ResolvedOrderLines {
  details: AccurateDetailItem[];
  unresolved: UnresolvedOrderLine[];
}

// Splits an order's lines into ones that can be written to Accurate and ones that
// can't. Exported so a caller (the webhooks) can check an order BEFORE it starts
// creating documents — recording an alert and stopping is far better than starting
// a SO/DO/SI chain that aborts partway through.
export async function resolveOrderLines(lineItems: OrderLineItem[]): Promise<ResolvedOrderLines> {
  const mappings = lineItems.map((line) => ({ line, mapping: getMappingForMarketplaceSku(line.sellerSku) }));
  const accurateSkus = mappings
    .map(({ mapping }) => mapping?.accurateSku)
    .filter((sku): sku is string => Boolean(sku));
  const accurateItemData = await fetchAccurateItemDataFor(accurateSkus);

  const details: AccurateDetailItem[] = [];
  const unresolved: UnresolvedOrderLine[] = [];

  for (const { line, mapping } of mappings) {
    const context = { sellerSku: line.sellerSku, productName: line.productName, variantName: line.variantName };

    if (!mapping) {
      unresolved.push({ ...context, reason: "No SKU mapping — this marketplace SKU isn't linked to any Accurate item yet" });
      continue;
    }

    const itemData = accurateItemData.get(mapping.accurateSku);
    if (!itemData) {
      unresolved.push({
        ...context,
        reason: `Mapped to Accurate item ${mapping.accurateSku}, but no such item exists in Accurate`,
      });
      continue;
    }

    const unit = itemData.units[mapping.unitLevel];
    if (!unit) {
      unresolved.push({
        ...context,
        reason: `Mapped to Accurate item ${mapping.accurateSku} at unit level ${mapping.unitLevel}, but that item has no unit at that level`,
      });
      continue;
    }

    const quantity = line.quantity * unit.ratio;
    // Fall back to Accurate's own item price if the marketplace didn't supply an
    // original/pre-promotion price (would otherwise zero out the gross value and
    // report the entire sale as a nonsensical negative discount).
    const grossUnitPrice = line.originalPrice || itemData.unitPrice || line.unitPrice;
    const grossTotal = grossUnitPrice * line.quantity;
    const actualTotal = line.unitPrice * line.quantity;

    details.push({
      itemNo: mapping.accurateSku,
      quantity,
      unitPrice: grossUnitPrice / unit.ratio,
      itemCashDiscount: grossTotal - actualTotal,
    });
  }

  return { details, unresolved };
}

export function describeUnresolvedLines(unresolved: UnresolvedOrderLine[], totalLines: number): string {
  return (
    `Refusing to write a document that would be missing ${unresolved.length} of ${totalLines} line(s): ` +
    `${unresolved.map((u) => `${u.sellerSku} (${u.reason})`).join("; ")}. Add the SKU mapping, then backfill this order.`
  );
}

async function toAccurateDetailItems(lineItems: OrderLineItem[]): Promise<AccurateDetailItem[]> {
  const { details, unresolved } = await resolveOrderLines(lineItems);

  if (unresolved.length > 0) {
    throw new Error(describeUnresolvedLines(unresolved, lineItems.length));
  }

  return details;
}

export interface CreateSalesOrderResult {
  salesOrderId: number;
  detailItems: AccurateDetailItem[];
}

// Returns the computed detail items (Accurate base-unit quantities, post-ratio)
// alongside the new SO id — the caller (tiktokWebhook.ts) needs these exact
// quantities to reserve stock immediately, without recomputing/re-fetching Accurate
// item data a second time.
export async function createSalesOrder(
  orderId: string,
  lineItems: OrderLineItem[],
  customerId: number = getTikTokCustomerId(),
  transDate: Date = new Date()
): Promise<CreateSalesOrderResult> {
  const detailItem = await toAccurateDetailItems(lineItems);

  if (detailItem.length === 0) {
    throw new Error(`No product-master SKUs in order ${orderId} — nothing to create a Sales Order for`);
  }

  const warehouseId = await getDefaultWarehouseId();

  const response = await callAccurateApi(
    "POST",
    "sales-order/save.do",
    {},
    {
      customerId,
      transDate: formatAccurateDate(transDate),
      warehouseId: Number(warehouseId),
      // Prefixed, not the raw order id — the Sales Invoice claims the raw id as its
      // own `number` later, and Accurate rejects reusing an identifier that's
      // already in use elsewhere (confirmed live: it treats poNumber and invoice
      // number as sharing one uniqueness space).
      poNumber: `SO-${orderId}`,
      inclusiveTax: true,
      detailItem,
    }
  );

  if (!response.data?.s) {
    throw new Error(`Accurate sales-order/save.do failed for TikTok order ${orderId}: ${JSON.stringify(response.data?.d ?? response.status)}`);
  }

  const salesOrderId = response.data?.r?.id ?? response.data?.d?.id;
  if (!salesOrderId) {
    throw new Error(`sales-order/save.do succeeded but no id was returned: ${JSON.stringify(response.data)}`);
  }

  return { salesOrderId: Number(salesOrderId), detailItems: detailItem };
}

export async function createDeliveryOrder(
  orderId: string,
  salesOrderId: number,
  lineItems: OrderLineItem[],
  customerId: number = getTikTokCustomerId(),
  transDate: Date = new Date()
): Promise<number> {
  const baseDetailItems = await toAccurateDetailItems(lineItems);
  const { detailIds: soDetailIds, transDate: soDate } = await fetchSalesOrderDetailIds(salesOrderId);

  if (baseDetailItems.length !== soDetailIds.length) {
    throw new Error(
      `SO ${salesOrderId} has ${soDetailIds.length} detail line(s) but ${baseDetailItems.length} were computed from the order's line items — refusing to guess which line is which (SKU mappings may have changed since the Sales Order was created)`
    );
  }

  const detailItem = baseDetailItems.map((item, i) => ({
    ...item,
    salesOrderId,
    salesOrderDetailId: soDetailIds[i],
  }));

  const warehouseId = await getDefaultWarehouseId();

  const response = await callAccurateApi(
    "POST",
    "delivery-order/save.do",
    {},
    {
      customerId,
      transDate: formatAccurateDate(notBefore(transDate, soDate)),
      warehouseId: Number(warehouseId),
      salesOrderId,
      // Raw order id, same as the Sales Invoice's `number` — confirmed live these
      // don't share a uniqueness namespace with each other (unlike SO's poNumber,
      // which does conflict with SI's number and needs its "SO-" prefix).
      number: orderId,
      inclusiveTax: true,
      detailItem,
    }
  );

  if (!response.data?.s) {
    throw new Error(`Accurate delivery-order/save.do failed for order ${orderId} (SO ${salesOrderId}): ${JSON.stringify(response.data?.d ?? response.status)}`);
  }

  const deliveryOrderId = response.data?.r?.id ?? response.data?.d?.id;
  if (!deliveryOrderId) {
    throw new Error(`delivery-order/save.do succeeded but no id was returned: ${JSON.stringify(response.data)}`);
  }

  return Number(deliveryOrderId);
}

export async function createSalesInvoice(
  orderId: string,
  salesOrderId: number,
  deliveryOrderId: number,
  lineItems: OrderLineItem[],
  customerId: number = getTikTokCustomerId(),
  transDate: Date = new Date()
): Promise<number> {
  const baseDetailItems = await toAccurateDetailItems(lineItems);
  const { rows: doDetailRows, transDate: doDate } = await fetchDeliveryOrderDetailRows(deliveryOrderId);

  if (baseDetailItems.length !== doDetailRows.length) {
    throw new Error(
      `DO ${deliveryOrderId} has ${doDetailRows.length} detail line(s) but ${baseDetailItems.length} were computed from the order's line items — refusing to guess which line is which (SKU mappings may have changed since the Delivery Order was created)`
    );
  }

  const detailItem = baseDetailItems.map((item, i) => ({
    ...item,
    salesOrderId,
    deliveryOrderId,
    salesOrderDetailId: doDetailRows[i].salesOrderDetailId,
    deliveryOrderDetailId: doDetailRows[i].id,
  }));

  const warehouseId = await getDefaultWarehouseId();

  const response = await callAccurateApi(
    "POST",
    "sales-invoice/save.do",
    {},
    {
      customerId,
      number: orderId,
      // A DO can never be dated before its SO (Accurate enforces it), so the DO's
      // date is the binding floor here.
      transDate: formatAccurateDate(notBefore(transDate, doDate)),
      warehouseId: Number(warehouseId),
      salesOrderId,
      deliveryOrderId,
      inclusiveTax: true,
      detailItem,
    }
  );

  if (!response.data?.s) {
    throw new Error(`Accurate sales-invoice/save.do failed for SO ${salesOrderId}/DO ${deliveryOrderId}: ${JSON.stringify(response.data?.d ?? response.status)}`);
  }

  const salesInvoiceId = response.data?.r?.id ?? response.data?.d?.id;
  if (!salesInvoiceId) {
    throw new Error(`sales-invoice/save.do succeeded but no id was returned: ${JSON.stringify(response.data)}`);
  }

  return Number(salesInvoiceId);
}

// Reverses a not-yet-invoiced order: deletes the Delivery Order (if one exists,
// reversing its stock decrement) and closes — does not hard-delete — the Sales
// Order, matching Accurate's own "Tutup Pesanan" (close order) convention so the
// audit trail is preserved. Confirmed live: the field is `manualClosed: true`
// (not `closeOrder`) — verified it flips status to "CLOSED"/"Ditutup".
export async function cancelOrder(salesOrderId: number, deliveryOrderId: number | null): Promise<void> {
  if (deliveryOrderId !== null) {
    const deleteResponse = await callAccurateApi("POST", "delivery-order/delete.do", { id: deliveryOrderId });

    if (!deleteResponse.data?.s) {
      throw new Error(`Accurate delivery-order/delete.do failed for DO ${deliveryOrderId}: ${JSON.stringify(deleteResponse.data?.d ?? deleteResponse.status)}`);
    }
  }

  const closeResponse = await callAccurateApi(
    "POST",
    "sales-order/save.do",
    {},
    {
      id: salesOrderId,
      manualClosed: true,
      closeReason: "Cancelled on TikTok",
    }
  );

  if (!closeResponse.data?.s) {
    throw new Error(`Accurate sales-order/save.do (close) failed for SO ${salesOrderId}: ${JSON.stringify(closeResponse.data?.d ?? closeResponse.status)}`);
  }
}

// Undoes cancelOrder's close for an order that turned out not to be cancelled
// (Shopee IN_CANCEL that the seller rejected). Only the SO can be brought back —
// the Delivery Order was hard-deleted and must be recreated by the caller.
export async function reopenSalesOrder(salesOrderId: number): Promise<void> {
  const response = await callAccurateApi(
    "POST",
    "sales-order/save.do",
    {},
    {
      id: salesOrderId,
      manualClosed: false,
      closeReason: "",
    }
  );

  if (!response.data?.s) {
    throw new Error(`Accurate sales-order/save.do (reopen) failed for SO ${salesOrderId}: ${JSON.stringify(response.data?.d ?? response.status)}`);
  }
}
