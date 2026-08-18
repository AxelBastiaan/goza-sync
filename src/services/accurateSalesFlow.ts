import { getEnv } from "../env";
import { callAccurateApi } from "./accurateClient";
import { getDefaultWarehouseId, formatAccurateDate } from "./accurateAdjustment";
import { fetchAccurateItemDataFor } from "./stockSync";
import { getMappingForMarketplaceSku } from "./skuMappings";
import { OrderLineItem } from "./tiktokOrders";

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
async function fetchSalesOrderDetailIds(salesOrderId: number): Promise<number[]> {
  const response = await callAccurateApi("GET", "sales-order/detail.do", { id: salesOrderId });
  if (!response.data?.s) {
    throw new Error(`Accurate sales-order/detail.do failed for SO ${salesOrderId}: ${JSON.stringify(response.data?.d ?? response.status)}`);
  }

  const items = (response.data?.d?.detailItem ?? []) as { id: number; seq?: number }[];
  return items
    .slice()
    .sort((a, b) => (a.seq ?? a.id) - (b.seq ?? b.id))
    .map((item) => item.id);
}

async function fetchDeliveryOrderDetailRows(deliveryOrderId: number): Promise<{ id: number; salesOrderDetailId: number }[]> {
  const response = await callAccurateApi("GET", "delivery-order/detail.do", { id: deliveryOrderId });
  if (!response.data?.s) {
    throw new Error(`Accurate delivery-order/detail.do failed for DO ${deliveryOrderId}: ${JSON.stringify(response.data?.d ?? response.status)}`);
  }

  const items = (response.data?.d?.detailItem ?? []) as { id: number; seq?: number; salesOrderDetailId: number }[];
  return items
    .slice()
    .sort((a, b) => (a.seq ?? a.id) - (b.seq ?? b.id))
    .map((item) => ({ id: item.id, salesOrderDetailId: item.salesOrderDetailId }));
}

// Converts TikTok order lines into Accurate detail lines, applying each line's
// mapped unit ratio: quantity is multiplied by the ratio (a "1 PAK" order becomes
// "10 PCS" in Accurate's base unit) and unitPrice is divided by the same ratio, so
// the total transaction value is preserved exactly (baseQty * basePrice === the
// original TikTok qty * price). Lines with no mapping, or whose mapped Accurate
// item doesn't have that unit level configured, are skipped (logged, not thrown).
export interface AccurateDetailItem {
  itemNo: string;
  quantity: number;
  unitPrice: number;
}

async function toAccurateDetailItems(lineItems: OrderLineItem[]): Promise<AccurateDetailItem[]> {
  const mappings = lineItems.map((line) => ({ line, mapping: getMappingForMarketplaceSku(line.sellerSku) }));
  const accurateSkus = mappings
    .map(({ mapping }) => mapping?.accurateSku)
    .filter((sku): sku is string => Boolean(sku));
  const accurateItemData = await fetchAccurateItemDataFor(accurateSkus);

  const details: { itemNo: string; quantity: number; unitPrice: number }[] = [];

  for (const { line, mapping } of mappings) {
    if (!mapping) {
      console.log(`[accurateSalesFlow] no mapping for marketplace SKU ${line.sellerSku}, skipping line`);
      continue;
    }

    const unit = accurateItemData.get(mapping.accurateSku)?.units[mapping.unitLevel];
    if (!unit) {
      console.warn(
        `[accurateSalesFlow] Accurate item ${mapping.accurateSku} has no unit level ${mapping.unitLevel} configured, skipping line for ${line.sellerSku}`
      );
      continue;
    }

    details.push({
      itemNo: mapping.accurateSku,
      quantity: line.quantity * unit.ratio,
      unitPrice: line.unitPrice / unit.ratio,
    });
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
  salesOrderId: number,
  lineItems: OrderLineItem[],
  customerId: number = getTikTokCustomerId(),
  transDate: Date = new Date()
): Promise<number> {
  const baseDetailItems = await toAccurateDetailItems(lineItems);
  const soDetailIds = await fetchSalesOrderDetailIds(salesOrderId);

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
      transDate: formatAccurateDate(transDate),
      warehouseId: Number(warehouseId),
      salesOrderId,
      inclusiveTax: true,
      detailItem,
    }
  );

  if (!response.data?.s) {
    throw new Error(`Accurate delivery-order/save.do failed for SO ${salesOrderId}: ${JSON.stringify(response.data?.d ?? response.status)}`);
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
  const doDetailRows = await fetchDeliveryOrderDetailRows(deliveryOrderId);

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
      transDate: formatAccurateDate(transDate),
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
