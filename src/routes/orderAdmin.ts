import { Router, Request, Response } from "express";
import { db } from "../db";
import { getOrderLineItems } from "../services/tiktokOrders";
import { createDeliveryOrder, createSalesInvoice } from "../services/accurateSalesFlow";
import { getTikTokStores } from "../services/storesRepo";
import { callAccurateApi } from "../services/accurateClient";

const router = Router();

type OrderStatus = "created" | "shipped" | "invoiced" | "cancelled";
const STAGE_ORDER: OrderStatus[] = ["created", "shipped", "invoiced"];

interface TikTokOrderRow {
  order_id: string;
  sales_order_id: number;
  delivery_order_id: number | null;
  sales_invoice_id: number | null;
  status: OrderStatus;
}

// One-off recovery tool for orders whose Sales Order was created in Accurate but
// whose Delivery Order / Sales Invoice never followed — the exact failure mode
// fixed prospectively in tiktokWebhook.ts (a marketplace's first-ever webhook for
// an order can already report a status past "created", and the marketplace never
// resends a status once reported, so the old strict-transition handler left those
// orders stuck forever). This pushes an already-stuck order forward by hand,
// reusing the same Accurate-writing functions the webhook path uses — no separate
// document-creation logic to trust. `transDate` lets the real historical event
// date be used instead of today, for orders discovered well after the fact.
router.post("/tiktok/:orderId/catchup", async (req: Request, res: Response) => {
  const { orderId } = req.params;
  const targetStage = req.body?.targetStage as OrderStatus | undefined;
  const transDateStr = req.body?.transDate as string | undefined; // "YYYY-MM-DD", optional

  if (targetStage !== "shipped" && targetStage !== "invoiced") {
    return res.status(400).json({ error: 'targetStage must be "shipped" or "invoiced"' });
  }

  let row = db.prepare("SELECT * FROM tiktok_orders WHERE order_id = ?").get(orderId) as TikTokOrderRow | undefined;
  if (!row) {
    return res.status(404).json({ error: `No Sales Order on file for TikTok order ${orderId}` });
  }
  if (row.status === "cancelled") {
    return res.status(409).json({ error: `Order ${orderId} is cancelled — refusing to create further documents` });
  }
  if (STAGE_ORDER.indexOf(targetStage) <= STAGE_ORDER.indexOf(row.status)) {
    return res.status(409).json({ error: `Order ${orderId} is already at "${row.status}" — nothing to catch up to "${targetStage}"` });
  }

  const stores = getTikTokStores();
  if (stores.length !== 1) {
    return res.status(400).json({ error: `Expected exactly one connected TikTok store to resolve credentials from, found ${stores.length}` });
  }
  const credentials = stores[0].credentials;
  const transDate = transDateStr ? new Date(transDateStr) : new Date();
  if (Number.isNaN(transDate.getTime())) {
    return res.status(400).json({ error: `Invalid transDate "${transDateStr}"` });
  }

  // This calls real Accurate write APIs — a rejection here (e.g. a document
  // number collision) must come back as a normal error response, not crash the
  // whole process. Anything already committed to Accurate/our own DB before the
  // failure (e.g. a Delivery Order created just before a Sales Invoice attempt
  // fails) stays committed; the response reports exactly how far it got.
  try {
    const lineItems = await getOrderLineItems(orderId, credentials);

    if (row.status === "created") {
      const deliveryOrderId = await createDeliveryOrder(row.sales_order_id, lineItems, undefined, transDate);
      db.prepare("UPDATE tiktok_orders SET delivery_order_id = ?, status = 'shipped' WHERE order_id = ?").run(deliveryOrderId, orderId);
      row = { ...row, delivery_order_id: deliveryOrderId, status: "shipped" };
      console.log(`[orderAdmin] manually created Delivery Order ${deliveryOrderId} for TikTok order ${orderId} (SO ${row.sales_order_id})`);
    }

    if (targetStage === "invoiced" && row.status === "shipped") {
      const salesInvoiceId = await createSalesInvoice(orderId, row.sales_order_id, row.delivery_order_id!, lineItems, undefined, transDate);
      db.prepare("UPDATE tiktok_orders SET sales_invoice_id = ?, status = 'invoiced' WHERE order_id = ?").run(salesInvoiceId, orderId);
      row = { ...row, sales_invoice_id: salesInvoiceId, status: "invoiced" };
      console.log(`[orderAdmin] manually created Sales Invoice ${salesInvoiceId} for TikTok order ${orderId}`);
    }

    res.json(row);
  } catch (err: any) {
    console.error(`[orderAdmin] catchup failed for TikTok order ${orderId}:`, err?.message ?? err);
    res.status(502).json({ error: err?.message ?? "Catchup failed", progress: row });
  }
});

// Read-only census of every order this app has ever recorded, grouped by
// status. `docker compose logs` only goes back to the current container's last
// start — a redeploy discards everything before it — so log-grepping badly
// undercounts how many orders are actually stuck; these tables persist across
// deploys and are the real source of truth for that.
router.get("/status-summary", (_req: Request, res: Response) => {
  const tiktokByStatus = db.prepare("SELECT status, COUNT(*) as count FROM tiktok_orders GROUP BY status").all();
  const tiktokStuck = db
    .prepare("SELECT order_id, sales_order_id, delivery_order_id, sales_invoice_id, status, created_at FROM tiktok_orders WHERE status IN ('created', 'shipped') ORDER BY created_at")
    .all();

  const shopeeByStatus = db.prepare("SELECT status, COUNT(*) as count FROM shopee_orders GROUP BY status").all();
  const shopeeStuck = db
    .prepare("SELECT order_sn, sales_order_id, delivery_order_id, sales_invoice_id, status, created_at FROM shopee_orders WHERE status IN ('created', 'shipped') ORDER BY created_at")
    .all();

  res.json({
    tiktok: { byStatus: tiktokByStatus, stuck: tiktokStuck },
    shopee: { byStatus: shopeeByStatus, stuck: shopeeStuck },
  });
});

// Read-only diagnostic: looks up whether a document with this exact `number`
// already exists in Accurate. Sales Invoice's `number` and Sales Order's
// `poNumber` share one uniqueness space in Accurate (confirmed live in
// accurateSalesFlow.ts) — this is how to find out what already holds an
// identifier before attempting to create a document that reuses it.
router.get("/accurate/lookup", async (req: Request, res: Response) => {
  const docType = req.query.docType as string | undefined;
  const number = req.query.number as string | undefined;
  const validDocTypes = ["sales-invoice", "sales-order", "delivery-order"];

  if (!docType || !validDocTypes.includes(docType)) {
    return res.status(400).json({ error: `docType must be one of: ${validDocTypes.join(", ")}` });
  }
  if (!number) {
    return res.status(400).json({ error: "number is required" });
  }

  // Sales Order's shared-identifier field is poNumber (createSalesOrder sets
  // poNumber, not number); Sales/Delivery Invoice-family docs use number directly.
  const filterField = docType === "sales-order" ? "poNumber" : "number";

  try {
    const response = await callAccurateApi("GET", `${docType}/list.do`, {
      [`filter.${filterField}.op`]: "EQUAL",
      [`filter.${filterField}.val`]: number,
    });
    res.json(response.data);
  } catch (err: any) {
    res.status(502).json({ error: err?.message ?? "Lookup failed" });
  }
});

export default router;
