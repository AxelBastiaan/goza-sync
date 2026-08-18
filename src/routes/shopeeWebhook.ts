import { Router, Request, Response } from "express";
import { db } from "../db";
import { getShopeeOrderLineItems } from "../services/shopeeOrders";
import { OrderLineItem } from "../services/tiktokOrders";
import { createSalesOrder, createDeliveryOrder, createSalesInvoice, cancelOrder, getShopeeCustomerId } from "../services/accurateSalesFlow";
import { verifyShopeeWebhookSignature } from "../services/shopeeClient";
import { isLiveMode } from "../services/settings";
import { getShopeeStoreByShopId } from "../services/storesRepo";
import { getMappingForMarketplaceSku } from "../services/skuMappings";
import { syncAllMappingsForAccurateSku } from "../services/stockSync";
import { syncAllMappingsForAccurateSkuShopee } from "../services/shopeeStockSync";

const router = Router();

// Push type codes, per Shopee's Live Push Setting (confirmed against what's
// actually activated in Partner Center for this app).
const CODE_ORDER_STATUS = 3;
const CODE_ORDER_TRACKINGNO = 4;

type OrderStatus = "created" | "shipped" | "invoiced" | "cancelled";

interface ShopeeOrderRow {
  order_sn: string;
  sales_order_id: number | null;
  delivery_order_id: number | null;
  sales_invoice_id: number | null;
  status: OrderStatus;
}

function getOrderRow(orderSn: string): ShopeeOrderRow | undefined {
  return db.prepare("SELECT * FROM shopee_orders WHERE order_sn = ?").get(orderSn) as ShopeeOrderRow | undefined;
}

function insertOrderRow(orderSn: string, salesOrderId: number): void {
  db.prepare("INSERT INTO shopee_orders (order_sn, sales_order_id, status, created_at) VALUES (?, ?, 'created', ?)").run(
    orderSn,
    salesOrderId,
    new Date().toISOString()
  );
}

function updateOrderRow(orderSn: string, fields: Partial<Pick<ShopeeOrderRow, "delivery_order_id" | "sales_invoice_id" | "status">>): void {
  const sets = Object.keys(fields)
    .map((key) => `${key} = @${key}`)
    .join(", ");
  db.prepare(`UPDATE shopee_orders SET ${sets} WHERE order_sn = @order_sn`).run({ order_sn: orderSn, ...fields });
}

function getAffectedAccurateSkus(lineItems: OrderLineItem[]): string[] {
  return lineItems
    .map((line) => getMappingForMarketplaceSku(line.sellerSku)?.accurateSku)
    .filter((sku): sku is string => Boolean(sku));
}

// Same reasoning as tiktokWebhook.ts's pushUpdatedStockFor: Accurate's
// availableToSell reflects a new SO/closed order instantly, so re-push right away
// to every connected store on both platforms rather than waiting for a scheduled sync.
async function pushUpdatedStockFor(accurateSkus: string[]): Promise<void> {
  for (const sku of [...new Set(accurateSkus)]) {
    try {
      const tiktokResults = await syncAllMappingsForAccurateSku(sku);
      if (tiktokResults.length > 0) {
        console.log(`[shopeeWebhook] re-pushed ${sku} to TikTok:`, JSON.stringify(tiktokResults));
      }
    } catch (err: any) {
      console.error(`[shopeeWebhook] failed to re-push ${sku} to TikTok:`, err?.message ?? err);
    }

    try {
      const shopeeResults = await syncAllMappingsForAccurateSkuShopee(sku);
      if (shopeeResults.length > 0) {
        console.log(`[shopeeWebhook] re-pushed ${sku} to Shopee:`, JSON.stringify(shopeeResults));
      }
    } catch (err: any) {
      console.error(`[shopeeWebhook] failed to re-push ${sku} to Shopee:`, err?.message ?? err);
    }
  }
}

router.post("/", async (req: Request, res: Response) => {
  console.log("[shopeeWebhook] raw headers:", JSON.stringify(req.headers));
  console.log("[shopeeWebhook] raw payload:", JSON.stringify(req.body));

  // Logging only, not rejecting — the url+body signature formula tested false
  // against real events, so it's not trustworthy yet. Switch to a hard 401 reject
  // like tiktokWebhook.ts once the real formula is confirmed.
  const rawBody = (req as any).rawBody as Buffer | undefined;
  const signatureValid = verifyShopeeWebhookSignature(rawBody, req.headers["authorization"] as string | undefined);
  console.log("[shopeeWebhook] signature valid:", signatureValid);
  console.log("[shopeeWebhook] DEBUG rawBody base64:", rawBody?.toString("base64"));

  const verifyInfo = req.body?.data?.verify_info;
  if (verifyInfo) {
    res.status(200).json({ code: 0, data: { verify_info: verifyInfo } });
    return;
  }

  // Ack immediately so Shopee doesn't retry/back off on a slow downstream call.
  res.status(200).json({ code: 0, msg: "" });

  const code = req.body?.code;
  const shopId = req.body?.shop_id ? String(req.body.shop_id) : undefined;
  const orderSn = req.body?.data?.ordersn as string | undefined;

  if (code !== CODE_ORDER_STATUS && code !== CODE_ORDER_TRACKINGNO) {
    console.log(`[shopeeWebhook] push code ${code} — no order-flow action needed`);
    return;
  }

  if (!orderSn) {
    console.warn("[shopeeWebhook] could not extract ordersn from payload — see raw log above");
    return;
  }

  if (!isLiveMode()) {
    console.log(`[shopeeWebhook] LIVE MODE OFF — received order ${orderSn} (code ${code}), not creating any Accurate documents`);
    return;
  }

  const store = shopId ? getShopeeStoreByShopId(shopId) : undefined;
  if (!store) {
    console.warn(`[shopeeWebhook] no connected store found for shop_id ${shopId} — cannot process order ${orderSn} without knowing which store's credentials to use`);
    return;
  }
  const credentials = store.credentials;
  const customerId = getShopeeCustomerId();

  try {
    let row = getOrderRow(orderSn);
    let lineItems: OrderLineItem[] | undefined;

    if (!row) {
      lineItems = await getShopeeOrderLineItems(orderSn, credentials);
      const { salesOrderId, detailItems } = await createSalesOrder(orderSn, lineItems, customerId);
      insertOrderRow(orderSn, salesOrderId);
      row = getOrderRow(orderSn)!;
      console.log(`[shopeeWebhook] created Sales Order ${salesOrderId} for order ${orderSn} (store: ${store.name})`);

      await pushUpdatedStockFor(detailItems.map((d) => d.itemNo));
    }

    const orderStatus = req.body?.data?.status as string | undefined;

    if (code === CODE_ORDER_TRACKINGNO && row.status === "created") {
      lineItems = lineItems ?? (await getShopeeOrderLineItems(orderSn, credentials));
      const deliveryOrderId = await createDeliveryOrder(row.sales_order_id!, lineItems, customerId);
      updateOrderRow(orderSn, { delivery_order_id: deliveryOrderId, status: "shipped" });
      console.log(`[shopeeWebhook] created Delivery Order ${deliveryOrderId} for order ${orderSn} (SO ${row.sales_order_id})`);

      await pushUpdatedStockFor(getAffectedAccurateSkus(lineItems));
    } else if (code === CODE_ORDER_STATUS && row.status === "shipped" && orderStatus === "COMPLETED") {
      lineItems = lineItems ?? (await getShopeeOrderLineItems(orderSn, credentials));
      const salesInvoiceId = await createSalesInvoice(orderSn, row.sales_order_id!, row.delivery_order_id!, lineItems, customerId);
      updateOrderRow(orderSn, { sales_invoice_id: salesInvoiceId, status: "invoiced" });
      console.log(`[shopeeWebhook] created Sales Invoice ${salesInvoiceId} for order ${orderSn}`);
    } else if (code === CODE_ORDER_STATUS && (row.status === "created" || row.status === "shipped") && (orderStatus === "CANCELLED" || orderStatus === "IN_CANCEL")) {
      lineItems = lineItems ?? (await getShopeeOrderLineItems(orderSn, credentials));
      const affectedSkus = getAffectedAccurateSkus(lineItems);

      await cancelOrder(row.sales_order_id!, row.delivery_order_id);
      updateOrderRow(orderSn, { status: "cancelled" });
      console.log(`[shopeeWebhook] cancelled order ${orderSn} (SO ${row.sales_order_id}, DO ${row.delivery_order_id ?? "none"})`);

      await pushUpdatedStockFor(affectedSkus);
    } else {
      console.log(`[shopeeWebhook] no action for order ${orderSn}: current status "${row.status}", incoming code ${code}, order_status "${orderStatus}"`);
    }
  } catch (err: any) {
    console.error(`[shopeeWebhook] failed to process order ${orderSn}:`, err?.message ?? err);
  }
});

export default router;
