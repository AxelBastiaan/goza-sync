import { Router, Request, Response } from "express";
import { db } from "../db";
import { getOrderLineItems, getOrderStatus } from "../services/tiktokOrders";
import { getShopeeOrderLineItems, getShopeeOrderSummaries } from "../services/shopeeOrders";
import { createSalesOrder, createDeliveryOrder, createSalesInvoice, getShopeeCustomerId } from "../services/accurateSalesFlow";
import { getTikTokStores, getShopeeStores } from "../services/storesRepo";
import { callAccurateApi } from "../services/accurateClient";
import { callShopeeApi, WEBHOOK_URL as SHOPEE_WEBHOOK_URL } from "../services/shopeeClient";

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
      const deliveryOrderId = await createDeliveryOrder(orderId, row.sales_order_id, lineItems, undefined, transDate);
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

// Batch reads each order's real current status straight from TikTok, rather
// than trusting whatever the last webhook we happened to receive said —
// needed before deciding what to catch up, since a webhook can be missed
// entirely rather than just arriving out of order.
router.post("/tiktok/bulk-live-status", async (req: Request, res: Response) => {
  const orderIds = req.body?.orderIds as string[] | undefined;
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return res.status(400).json({ error: "orderIds must be a non-empty array" });
  }

  const stores = getTikTokStores();
  if (stores.length !== 1) {
    return res.status(400).json({ error: `Expected exactly one connected TikTok store to resolve credentials from, found ${stores.length}` });
  }
  const credentials = stores[0].credentials;

  const results: { orderId: string; status?: string; error?: string }[] = [];
  for (const orderId of orderIds) {
    try {
      const status = await getOrderStatus(orderId, credentials);
      results.push({ orderId, status });
    } catch (err: any) {
      results.push({ orderId, error: err?.message ?? String(err) });
    }
  }

  res.json(results);
});

// Deletes the Delivery Order (if any) and the Sales Order for each given order,
// then removes the local tiktok_orders row entirely — for orders whose real
// bookkeeping happened by hand directly in Accurate (pre-automation), where our
// own automated SO/DO are redundant duplicates rather than the source of truth.
// Never touches an order already at "invoiced" (a Sales Invoice references its
// Sales Order — deleting under it would corrupt real accounting data) or
// "cancelled" (already reconciled). Processes each order independently so one
// failure doesn't abort the rest of the batch.
router.post("/tiktok/bulk-delete-so-do", async (req: Request, res: Response) => {
  const orderIds = req.body?.orderIds as string[] | undefined;
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return res.status(400).json({ error: "orderIds must be a non-empty array" });
  }

  // Accurate returns this exact rejection when the target id doesn't exist
  // (confirmed live) -- some of these SOs were apparently already cleaned up
  // directly in Accurate, presumably by whoever did the manual bookkeeping for
  // this period. That's the desired end state already achieved, not a failure.
  const isAlreadyGone = (data: any): boolean =>
    Array.isArray(data?.d) && data.d.some((m: unknown) => typeof m === "string" && m.includes("tidak ditemukan atau sudah dihapus"));

  const results: { orderId: string; deleted?: { salesOrderId: number; deliveryOrderId: number | null }; alreadyGone?: boolean; error?: string }[] = [];

  for (const orderId of orderIds) {
    try {
      const row = db.prepare("SELECT * FROM tiktok_orders WHERE order_id = ?").get(orderId) as TikTokOrderRow | undefined;
      if (!row) {
        results.push({ orderId, error: "No row on file" });
        continue;
      }
      if (row.status === "invoiced" || row.status === "cancelled") {
        results.push({ orderId, error: `Refusing to delete — order is already "${row.status}"` });
        continue;
      }

      let alreadyGone = false;

      if (row.delivery_order_id !== null) {
        const deleteDoResponse = await callAccurateApi("POST", "delivery-order/delete.do", { id: row.delivery_order_id });
        if (!deleteDoResponse.data?.s) {
          if (isAlreadyGone(deleteDoResponse.data)) {
            alreadyGone = true;
          } else {
            throw new Error(`delivery-order/delete.do failed for DO ${row.delivery_order_id}: ${JSON.stringify(deleteDoResponse.data?.d ?? deleteDoResponse.status)}`);
          }
        }
      }

      const deleteSoResponse = await callAccurateApi("POST", "sales-order/delete.do", { id: row.sales_order_id });
      if (!deleteSoResponse.data?.s) {
        if (isAlreadyGone(deleteSoResponse.data)) {
          alreadyGone = true;
        } else {
          throw new Error(`sales-order/delete.do failed for SO ${row.sales_order_id}: ${JSON.stringify(deleteSoResponse.data?.d ?? deleteSoResponse.status)}`);
        }
      }

      db.prepare("DELETE FROM tiktok_orders WHERE order_id = ?").run(orderId);
      console.log(`[orderAdmin] ${alreadyGone ? "cleared local row for already-deleted" : "deleted"} SO ${row.sales_order_id}${row.delivery_order_id ? ` and DO ${row.delivery_order_id}` : ""} for TikTok order ${orderId}`);
      results.push({ orderId, deleted: { salesOrderId: row.sales_order_id, deliveryOrderId: row.delivery_order_id }, alreadyGone });
    } catch (err: any) {
      console.error(`[orderAdmin] bulk-delete failed for TikTok order ${orderId}:`, err?.message ?? err);
      results.push({ orderId, error: err?.message ?? String(err) });
    }
  }

  res.json(results);
});

// Read-only: asks Shopee directly for its real order volume in a date range,
// bypassing our webhook pipeline entirely. shopee_orders being empty is
// ambiguous on its own -- it means either Shopee genuinely has no orders yet,
// or orders exist but the webhook never reached/registered with us (unconfirmed
// signature verification, a Partner Center subscription gap, etc). This settles
// which one it is against Shopee's own source of truth.
router.get("/shopee/recent-orders", async (req: Request, res: Response) => {
  // Shopee's own API caps this range at 15 days.
  const days = Math.min(Number(req.query.days) || 15, 15);

  const stores = getShopeeStores();
  if (stores.length !== 1) {
    return res.status(400).json({ error: `Expected exactly one connected Shopee store, found ${stores.length}` });
  }
  const credentials = stores[0].credentials;

  const timeTo = Math.floor(Date.now() / 1000);
  const timeFrom = timeTo - days * 24 * 60 * 60;

  try {
    const response = await callShopeeApi(
      "GET",
      "/api/v2/order/get_order_list",
      {
        // order_status is optional per Shopee's doc and returns every status when
        // omitted — "ALL" is not itself a valid enum value (confirmed live: Shopee
        // rejected it with error_param).
        time_range_field: "create_time",
        time_from: timeFrom,
        time_to: timeTo,
        page_size: 100,
      },
      null,
      credentials
    );

    if (response.data?.error) {
      return res.status(502).json({ error: `${response.data.error}: ${response.data.message}` });
    }

    const orders = response.data?.response?.order_list ?? [];
    res.json({
      daysChecked: days,
      totalFromShopee: response.data?.response?.more ? `${orders.length}+ (more pages exist)` : orders.length,
      orders,
    });
  } catch (err: any) {
    res.status(502).json({ error: err?.message ?? "Failed to reach Shopee" });
  }
});

// Read-only: compares our own configured SHOPEE_WEBHOOK_URL against what Shopee's
// Partner API actually has on file as the Live Push callback URL/event
// subscription for this app. shopee_orders having zero rows despite 93+ real
// orders existing (confirmed via /shopee/recent-orders) means events aren't
// reaching us at all — this settles whether that's because Shopee was never
// told to call us (URL mismatch/no subscription) versus a bug on our side.
router.get("/shopee/webhook-config", async (_req: Request, res: Response) => {
  try {
    const response = await callShopeeApi("GET", "/api/v2/push/get_push_config", {});
    res.json({
      ourConfiguredWebhookUrl: SHOPEE_WEBHOOK_URL || null,
      shopeePushConfig: response.data,
    });
  } catch (err: any) {
    res.status(502).json({ error: err?.message ?? "Failed to reach Shopee", ourConfiguredWebhookUrl: SHOPEE_WEBHOOK_URL || null });
  }
});

// Repoints Shopee's Live Push callback_url to our own SHOPEE_WEBHOOK_URL — fixes
// exactly the gap /shopee/webhook-config found live: Shopee had been faithfully
// firing every order event at a now-dead ngrok tunnel from before this app moved
// to the VPS, so none of it ever reached us. Re-reads the current push_config
// first and resubmits it byte-for-byte except callback_url, so none of the
// other already-enabled event subscriptions (shop authorization, item
// promotion, etc.) get silently dropped by only sending a partial config.
router.post("/shopee/webhook-config/fix", async (_req: Request, res: Response) => {
  if (!SHOPEE_WEBHOOK_URL) {
    return res.status(400).json({ error: "SHOPEE_WEBHOOK_URL is not set" });
  }

  try {
    const currentResponse = await callShopeeApi("GET", "/api/v2/push/get_push_config", {});
    if (currentResponse.data?.error) {
      return res.status(502).json({ error: `get_push_config failed: ${currentResponse.data.error}: ${currentResponse.data.message}` });
    }
    const current = currentResponse.data;

    if (current.callback_url === SHOPEE_WEBHOOK_URL) {
      return res.json({ alreadyCorrect: true, callback_url: current.callback_url });
    }

    const setResponse = await callShopeeApi(
      "POST",
      "/api/v2/push/set_push_config",
      {},
      {
        callback_url: SHOPEE_WEBHOOK_URL,
        push_config: current.push_config,
      }
    );

    if (setResponse.data?.error) {
      return res.status(502).json({ error: `set_push_config failed: ${setResponse.data.error}: ${setResponse.data.message}`, previousCallbackUrl: current.callback_url });
    }

    console.log(`[orderAdmin] Shopee callback_url updated from ${current.callback_url} to ${SHOPEE_WEBHOOK_URL}`);
    res.json({ updated: true, previousCallbackUrl: current.callback_url, newCallbackUrl: SHOPEE_WEBHOOK_URL, response: setResponse.data });
  } catch (err: any) {
    res.status(502).json({ error: err?.message ?? "Failed to reach Shopee" });
  }
});

// Shopee's real order_status enum mapped to our stage model. CANCELLED/IN_CANCEL
// are handled separately by the caller (nothing gets created in Accurate for an
// order that's already dead). TO_RETURN and INVOICE_PENDING are deliberately
// left unmapped (undefined) rather than guessed at — a return in progress or a
// pending-invoice state needs a human call, not an automated push.
function shopeeStatusToStage(orderStatus: string): OrderStatus | undefined {
  switch (orderStatus) {
    case "COMPLETED":
      return "invoiced";
    case "SHIPPED":
    case "TO_CONFIRM_RECEIVE":
      return "shipped";
    case "READY_TO_SHIP":
    case "PROCESSED":
    case "UNPAID":
      return "created";
    case "CANCELLED":
    case "IN_CANCEL":
      return "cancelled";
    default:
      return undefined;
  }
}

// Read-only: lists every Shopee order created on/after `since` (default the
// 2026-08-19 automation cutover) with its real current status and the stage our
// system would push it to — the reconciliation report for the webhook-callback
// gap found and fixed via /shopee/webhook-config. Writes nothing; run
// /shopee/bulk-backfill against the returned orderSns once reviewed.
router.get("/shopee/orders-since", async (req: Request, res: Response) => {
  const sinceStr = (req.query.since as string) || "2026-08-19";
  const since = new Date(`${sinceStr}T00:00:00+07:00`); // Asia/Jakarta, matches the business's own timezone elsewhere in this app
  if (Number.isNaN(since.getTime())) {
    return res.status(400).json({ error: `Invalid since date "${sinceStr}"` });
  }
  const sinceEpoch = Math.floor(since.getTime() / 1000);

  const stores = getShopeeStores();
  if (stores.length !== 1) {
    return res.status(400).json({ error: `Expected exactly one connected Shopee store, found ${stores.length}` });
  }
  const credentials = stores[0].credentials;

  try {
    // Shopee's get_order_list caps at 15 days; walk back in 15-day windows until
    // we've covered everything back to `since` (or hit an empty page).
    const timeTo = Math.floor(Date.now() / 1000);
    const allOrderSns = new Set<string>();
    let windowEnd = timeTo;
    while (windowEnd > sinceEpoch) {
      const windowStart = Math.max(sinceEpoch, windowEnd - 15 * 24 * 60 * 60);
      const listResponse = await callShopeeApi(
        "GET",
        "/api/v2/order/get_order_list",
        { time_range_field: "create_time", time_from: windowStart, time_to: windowEnd, page_size: 100 },
        null,
        credentials
      );
      if (listResponse.data?.error) {
        return res.status(502).json({ error: `get_order_list failed: ${listResponse.data.error}: ${listResponse.data.message}` });
      }
      for (const o of listResponse.data?.response?.order_list ?? []) {
        allOrderSns.add(o.order_sn);
      }
      windowEnd = windowStart;
    }

    const summaries = await getShopeeOrderSummaries([...allOrderSns], credentials);
    const inRange = summaries.filter((o) => o.createTime >= sinceEpoch);

    const alreadyOnFile = new Set(
      (db.prepare("SELECT order_sn FROM shopee_orders").all() as { order_sn: string }[]).map((r) => r.order_sn)
    );

    const report = inRange.map((o) => ({
      ...o,
      createdAtJakarta: new Date(o.createTime * 1000).toLocaleString("en-US", { timeZone: "Asia/Jakarta" }),
      targetStage: shopeeStatusToStage(o.orderStatus),
      alreadyOnFile: alreadyOnFile.has(o.orderSn),
    }));

    res.json({
      since: sinceStr,
      totalInRange: report.length,
      needsReview: report.filter((o) => !o.targetStage).length,
      byTargetStage: {
        created: report.filter((o) => o.targetStage === "created").length,
        shipped: report.filter((o) => o.targetStage === "shipped").length,
        invoiced: report.filter((o) => o.targetStage === "invoiced").length,
        cancelled: report.filter((o) => o.targetStage === "cancelled").length,
        unrecognizedStatus: report.filter((o) => !o.targetStage).length,
      },
      orders: report,
    });
  } catch (err: any) {
    res.status(502).json({ error: err?.message ?? "Failed to reach Shopee" });
  }
});

// Pushes a batch of Shopee orders through the same Sales Order -> Delivery Order
// -> Sales Invoice progression the webhook handler would have, using each
// order's real current status (not a webhook payload, since none ever arrived —
// see /shopee/orders-since). Orders already CANCELLED are skipped without
// writing anything to Accurate (closing something that was never opened serves
// no purpose); orders with no recognized target stage (TO_RETURN,
// INVOICE_PENDING, etc.) are skipped for manual review. Every other order gets
// its Sales Order created, then progresses through Delivery Order/Sales Invoice
// as far as its real status implies. Each order is fully independent — one
// failure doesn't stop or corrupt the rest of the batch.
router.post("/shopee/bulk-backfill", async (req: Request, res: Response) => {
  const orderSns = req.body?.orderSns as string[] | undefined;
  if (!Array.isArray(orderSns) || orderSns.length === 0) {
    return res.status(400).json({ error: "orderSns must be a non-empty array" });
  }

  const stores = getShopeeStores();
  if (stores.length !== 1) {
    return res.status(400).json({ error: `Expected exactly one connected Shopee store, found ${stores.length}` });
  }
  const credentials = stores[0].credentials;
  const customerId = getShopeeCustomerId();

  const summaries = await getShopeeOrderSummaries(orderSns, credentials);
  const summaryBySn = new Map(summaries.map((s) => [s.orderSn, s]));

  const results: { orderSn: string; skipped?: string; progress?: any; error?: string }[] = [];

  for (const orderSn of orderSns) {
    try {
      const existing = db.prepare("SELECT 1 FROM shopee_orders WHERE order_sn = ?").get(orderSn);
      if (existing) {
        results.push({ orderSn, skipped: "Already on file" });
        continue;
      }

      const summary = summaryBySn.get(orderSn);
      if (!summary) {
        results.push({ orderSn, error: "Could not fetch order status from Shopee" });
        continue;
      }

      if (summary.orderStatus === "CANCELLED" || summary.orderStatus === "IN_CANCEL") {
        results.push({ orderSn, skipped: `Order is ${summary.orderStatus} — nothing to push` });
        continue;
      }

      const targetStage = shopeeStatusToStage(summary.orderStatus);
      if (!targetStage) {
        results.push({ orderSn, skipped: `Unrecognized status "${summary.orderStatus}" — needs manual review` });
        continue;
      }

      const transDate = new Date(summary.createTime * 1000);
      const lineItems = await getShopeeOrderLineItems(orderSn, credentials);
      if (lineItems.length === 0) {
        results.push({ orderSn, error: "No mapped line items found for this order" });
        continue;
      }

      const { salesOrderId } = await createSalesOrder(orderSn, lineItems, customerId, transDate);
      let deliveryOrderId: number | null = null;
      let salesInvoiceId: number | null = null;

      if (STAGE_ORDER.indexOf(targetStage) >= STAGE_ORDER.indexOf("shipped")) {
        deliveryOrderId = await createDeliveryOrder(orderSn, salesOrderId, lineItems, customerId, transDate);
      }
      if (targetStage === "invoiced" && deliveryOrderId !== null) {
        salesInvoiceId = await createSalesInvoice(orderSn, salesOrderId, deliveryOrderId, lineItems, customerId, transDate);
      }

      const finalStatus: OrderStatus = salesInvoiceId ? "invoiced" : deliveryOrderId ? "shipped" : "created";
      db.prepare(
        "INSERT INTO shopee_orders (order_sn, sales_order_id, delivery_order_id, sales_invoice_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(orderSn, salesOrderId, deliveryOrderId, salesInvoiceId, finalStatus, transDate.toISOString());

      console.log(`[orderAdmin] backfilled Shopee order ${orderSn}: SO ${salesOrderId}${deliveryOrderId ? `, DO ${deliveryOrderId}` : ""}${salesInvoiceId ? `, SI ${salesInvoiceId}` : ""}`);
      results.push({ orderSn, progress: { salesOrderId, deliveryOrderId, salesInvoiceId, status: finalStatus } });
    } catch (err: any) {
      console.error(`[orderAdmin] backfill failed for Shopee order ${orderSn}:`, err?.message ?? err);
      results.push({ orderSn, error: err?.message ?? String(err) });
    }
  }

  res.json(results);
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
