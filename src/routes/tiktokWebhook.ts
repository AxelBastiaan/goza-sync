import { Router, Request, Response } from "express";
import { db } from "../db";
import { getOrderDetail, TikTokOrderDetail, OrderLineItem } from "../services/tiktokOrders";
import { createSalesOrder, createDeliveryOrder, createSalesInvoice, cancelOrder } from "../services/accurateSalesFlow";
import { verifyWebhookSignature } from "../services/tiktokClient";
import { isLiveMode } from "../services/settings";
import { getTikTokStoreByShopId } from "../services/storesRepo";
import { getMappingForMarketplaceSku } from "../services/skuMappings";
import { syncAllMappingsForAccurateSku } from "../services/stockSync";
import { syncAllMappingsForAccurateSkuShopee } from "../services/shopeeStockSync";

const router = Router();

type OrderStatus = "created" | "shipped" | "invoiced" | "cancelled";

interface TikTokOrderRow {
  order_id: string;
  sales_order_id: number | null;
  delivery_order_id: number | null;
  sales_invoice_id: number | null;
  status: OrderStatus;
}

// NOTE: field paths are best-effort guesses confirmed against TikTok's documented
// webhook payload shape (data.order_id, data.order_status). The exact enum values
// for AWAITING_COLLECTION/DELIVERED/CANCELLED are per the user's description of
// their TikTok seller UI ("resi dicetak" = AWAITING_COLLECTION, "Terkirim" =
// DELIVERED) — verify against real order lifecycle events and adjust if wrong.
function extractOrderId(body: any): string | undefined {
  return body?.data?.order_id ?? undefined;
}

function extractOrderStatus(body: any): string | undefined {
  return body?.data?.order_status ?? undefined;
}

// TikTok's webhook envelope includes shop_id at the top level (confirmed from raw
// payloads logged live), which is how a multi-store setup knows which store's
// credentials to use for the rest of this order's API calls.
function extractShopId(body: any): string | undefined {
  return body?.shop_id ?? undefined;
}

function getOrderRow(orderId: string): TikTokOrderRow | undefined {
  return db.prepare("SELECT * FROM tiktok_orders WHERE order_id = ?").get(orderId) as TikTokOrderRow | undefined;
}

function insertOrderRow(orderId: string, salesOrderId: number): void {
  db.prepare(
    "INSERT INTO tiktok_orders (order_id, sales_order_id, status, created_at) VALUES (?, ?, 'created', ?)"
  ).run(orderId, salesOrderId, new Date().toISOString());
}

function updateOrderRow(orderId: string, fields: Partial<Pick<TikTokOrderRow, "delivery_order_id" | "sales_invoice_id" | "status">>): void {
  const sets = Object.keys(fields).map((key) => `${key} = @${key}`).join(", ");
  db.prepare(`UPDATE tiktok_orders SET ${sets} WHERE order_id = @order_id`).run({ order_id: orderId, ...fields });
}

const STAGE_ORDER: OrderStatus[] = ["created", "shipped", "invoiced"];

// TikTok's webhook delivery isn't guaranteed to hit every intermediate status for
// every order — confirmed live: several orders' very first webhook event already
// reported IN_TRANSIT, DELIVERED, or COMPLETED, with no AWAITING_COLLECTION event
// ever received first. Reacting only to one exact transition (created ->
// AWAITING_COLLECTION, shipped -> DELIVERED) left those orders stuck with just a
// Sales Order forever, since TikTok never re-sends a status it already reported.
// Treating the incoming status as implying a target stage, and catching up
// through everything in between, fixes that regardless of which event arrives
// first or whether one gets missed.
function impliedStage(orderStatus: string | undefined): OrderStatus | undefined {
  switch (orderStatus) {
    case "DELIVERED":
    case "COMPLETED":
      return "invoiced";
    case "AWAITING_COLLECTION":
    case "IN_TRANSIT":
      return "shipped";
    case "CANCELLED":
      return "cancelled";
    default:
      return undefined;
  }
}

// Resolves which Accurate SKUs an order's line items actually correspond to, via the
// existing marketplace-SKU mappings — used wherever we need to re-push stock for an
// order but don't already have its resolved Accurate SKUs on hand.
function getAffectedAccurateSkus(lineItems: OrderLineItem[]): string[] {
  return lineItems
    .map((line) => getMappingForMarketplaceSku(line.sellerSku)?.accurateSku)
    .filter((sku): sku is string => Boolean(sku));
}

// Pushes freshly-recomputed stock to every connected store for each affected
// Accurate SKU, right away — doesn't wait for a manual Sync Now click or for
// Accurate's own stock-change webhook (which only fires once a Delivery Order
// actually moves real stock, and isn't confirmed to fire reliably in this
// environment). Accurate's own `availableToSell` already reflects the new Sales
// Order the instant it's saved, so this just needs to ask Accurate again and
// propagate — no local reservation bookkeeping required.
async function pushUpdatedStockFor(accurateSkus: string[]): Promise<void> {
  for (const sku of [...new Set(accurateSkus)]) {
    try {
      const tiktokResults = await syncAllMappingsForAccurateSku(sku);
      if (tiktokResults.length > 0) {
        console.log(`[tiktokWebhook] re-pushed ${sku} to TikTok:`, JSON.stringify(tiktokResults));
      }
    } catch (err: any) {
      console.error(`[tiktokWebhook] failed to re-push ${sku} to TikTok:`, err?.message ?? err);
    }

    try {
      const shopeeResults = await syncAllMappingsForAccurateSkuShopee(sku);
      if (shopeeResults.length > 0) {
        console.log(`[tiktokWebhook] re-pushed ${sku} to Shopee:`, JSON.stringify(shopeeResults));
      }
    } catch (err: any) {
      console.error(`[tiktokWebhook] failed to re-push ${sku} to Shopee:`, err?.message ?? err);
    }
  }
}

router.post("/", async (req: Request, res: Response) => {
  console.log("[tiktokWebhook] raw headers:", JSON.stringify(req.headers));
  console.log("[tiktokWebhook] raw payload:", JSON.stringify(req.body));

  const rawBody = (req as any).rawBody as Buffer | undefined;
  const signature = req.headers["authorization"] as string | undefined;

  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn("[tiktokWebhook] signature verification failed — rejecting");
    res.status(401).end();
    return;
  }

  // Ack immediately so TikTok doesn't retry/back off on a slow downstream call.
  res.status(200).json({ received: true });

  const orderId = extractOrderId(req.body);
  const orderStatus = extractOrderStatus(req.body);
  const shopId = extractShopId(req.body);

  if (!orderId) {
    console.warn("[tiktokWebhook] could not extract an order id from payload — see raw log above");
    return;
  }

  if (!isLiveMode()) {
    console.log(`[tiktokWebhook] LIVE MODE OFF — received order ${orderId} (order_status: ${orderStatus}), not creating any Accurate documents`);
    return;
  }

  const store = shopId ? getTikTokStoreByShopId(shopId) : undefined;
  if (!store) {
    console.warn(`[tiktokWebhook] no connected store found for shop_id ${shopId} — cannot process order ${orderId} without knowing which store's credentials to use`);
    return;
  }
  const credentials = store.credentials;

  try {
    let row = getOrderRow(orderId);
    // Carries the order's real placement date alongside its line items — every
    // Accurate document below is dated from it (see TikTokOrderDetail.createdAt),
    // so a DELIVERED event arriving a week after the sale still books the sale on
    // the day it happened. Passing undefined leaves accurateSalesFlow's own
    // `new Date()` default in place, so a missing create_time degrades to the
    // previous behavior rather than failing.
    let detail: TikTokOrderDetail | undefined;

    if (!row) {
      detail = await getOrderDetail(orderId, credentials);
      const { salesOrderId, detailItems } = await createSalesOrder(orderId, detail.lineItems, undefined, detail.createdAt);
      insertOrderRow(orderId, salesOrderId);
      row = getOrderRow(orderId)!;
      console.log(`[tiktokWebhook] created Sales Order ${salesOrderId} for order ${orderId} (store: ${store.name})`);

      // Accurate's availableToSell already reflects this new Sales Order the moment
      // it's saved — just re-push so every other store's listing catches up now
      // instead of waiting for the next manual/scheduled sync.
      await pushUpdatedStockFor(detailItems.map((d) => d.itemNo));
    }

    const target = impliedStage(orderStatus);

    if (target === "cancelled") {
      if (row.status === "created" || row.status === "shipped") {
        detail = detail ?? (await getOrderDetail(orderId, credentials));
        const affectedSkus = getAffectedAccurateSkus(detail.lineItems);

        await cancelOrder(row.sales_order_id!, row.delivery_order_id);
        updateOrderRow(orderId, { status: "cancelled" });
        console.log(`[tiktokWebhook] cancelled order ${orderId} (SO ${row.sales_order_id}, DO ${row.delivery_order_id ?? "none"})`);

        // cancelOrder() closes the Sales Order (and reverses the Delivery Order's
        // stock decrement if one existed) — Accurate's availableToSell reflects that
        // immediately, so just re-push to every store.
        await pushUpdatedStockFor(affectedSkus);
      } else {
        console.log(`[tiktokWebhook] no action for order ${orderId}: current status "${row.status}", incoming order_status "${orderStatus}"`);
      }
    } else if (target && row.status !== "cancelled" && STAGE_ORDER.indexOf(target) > STAGE_ORDER.indexOf(row.status)) {
      // Catches up through every stage between the current one and the stage the
      // incoming status implies, rather than requiring one exact transition — see
      // impliedStage()'s comment for why.
      detail = detail ?? (await getOrderDetail(orderId, credentials));

      if (row.status === "created") {
        const deliveryOrderId = await createDeliveryOrder(orderId, row.sales_order_id!, detail.lineItems, undefined, detail.createdAt);
        updateOrderRow(orderId, { delivery_order_id: deliveryOrderId, status: "shipped" });
        row = { ...row, delivery_order_id: deliveryOrderId, status: "shipped" };
        console.log(`[tiktokWebhook] created Delivery Order ${deliveryOrderId} for order ${orderId} (SO ${row.sales_order_id})`);

        // Physical stock has now actually decremented too — re-push so every store's
        // number reflects it (availableToSell already accounted for the Sales Order
        // stage, so this mainly matters if the on-hand/gudang figure is surfaced
        // anywhere, and keeps behavior consistent regardless).
        await pushUpdatedStockFor(getAffectedAccurateSkus(detail.lineItems));
      }

      if (target === "invoiced" && row.status === "shipped") {
        const salesInvoiceId = await createSalesInvoice(orderId, row.sales_order_id!, row.delivery_order_id!, detail.lineItems, undefined, detail.createdAt);
        updateOrderRow(orderId, { sales_invoice_id: salesInvoiceId, status: "invoiced" });
        console.log(`[tiktokWebhook] created Sales Invoice ${salesInvoiceId} for order ${orderId}`);
      }
    } else {
      console.log(`[tiktokWebhook] no action for order ${orderId}: current status "${row.status}", incoming order_status "${orderStatus}"`);
    }
  } catch (err: any) {
    console.error(`[tiktokWebhook] failed to process order ${orderId}:`, err?.message ?? err);
  }
});

export default router;
