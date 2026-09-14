import { callShopeeApi, ShopeeStoreCredentials } from "./shopeeClient";
import { OrderLineItem } from "./tiktokOrders";

export interface ShopeeOrderSummary {
  orderSn: string;
  createTime: number;
  orderStatus: string;
}

// Batch reads each order's real creation time + current status directly from
// Shopee — used for reconciling a backlog of orders whose webhook events never
// reached us (rather than one order_sn at a time via getShopeeOrderLineItems,
// which also pulls full line items we don't need just to triage a list).
// get_order_detail accepts at most 50 order_sn per call.
export async function getShopeeOrderSummaries(orderSns: string[], credentials: ShopeeStoreCredentials): Promise<ShopeeOrderSummary[]> {
  const results: ShopeeOrderSummary[] = [];

  for (let i = 0; i < orderSns.length; i += 50) {
    const chunk = orderSns.slice(i, i + 50);
    const response = await callShopeeApi(
      "GET",
      "/api/v2/order/get_order_detail",
      { order_sn_list: chunk.join(","), response_optional_fields: "create_time,order_status" },
      null,
      credentials
    );

    if (response.data?.error) {
      console.warn(`[shopeeOrders] get_order_detail batch failed: ${response.data.error}: ${response.data.message}`);
      continue;
    }

    const orders = response.data?.response?.order_list ?? [];
    for (const o of orders) {
      results.push({ orderSn: o.order_sn, createTime: o.create_time, orderStatus: o.order_status });
    }
  }

  return results;
}

// Confirmed live against a real order (26073025T0NA83): item_list entries carry
// model_sku (the seller-set variant SKU — matches what shopeeStockSync.ts already
// keys stock updates on) plus model_discounted_price/model_original_price.
// model_discounted_price is used as the invoiced unit price — it's the actual
// transacted price for the line. Unconfirmed edge case, same trap that caused the
// TikTok pricing bug: if Shopee ever applies a platform-funded ("shopee_discount")
// promotion on top, model_discounted_price may net that out too, which would
// under-invoice the same way TikTok's `sale_price` did. promotion_list tags each
// item's promotion type — worth cross-checking against a real shopee_discount
// example (and admin's manually-booked amount) before fully trusting this on an
// order with mixed promotion types.
export interface ShopeeOrderDetail {
  lineItems: OrderLineItem[];
  // See TikTokOrderDetail.createdAt — same purpose: book the Accurate documents
  // on the order's own date, not the date its webhook happened to arrive.
  createdAt: Date | undefined;
}

// A Shopee order sn begins with YYMMDD — but in UTC+8 (Shopee's regional time),
// NOT the shop's Jakarta time (UTC+7). An order placed between 23:00 and midnight
// Jakarta therefore carries the NEXT day's date in its order number.
//
// So this is a best-effort fallback only, accurate for ~23 of every 24 hours and
// one day late for the rest. create_time is the authoritative source and must be
// preferred wherever it is available; do not use this to "correct" existing
// documents in bulk. Learned the hard way: a bulk correction driven off this
// prefix moved 20 already-correct invoices onto the wrong day, because the
// sample used to validate the rule happened to contain no late-evening orders.
export function shopeeOrderDateFromSn(orderSn: string): Date | undefined {
  if (!/^\d{6}[A-Z0-9]{6,}$/.test(orderSn)) return undefined;
  const yy = Number(orderSn.slice(0, 2));
  const mm = Number(orderSn.slice(2, 4));
  const dd = Number(orderSn.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return undefined;
  // Midday Jakarta (05:00 UTC) — safely inside the day regardless of how the
  // date is later rendered, so the fallback can't itself drift a day.
  return new Date(Date.UTC(2000 + yy, mm - 1, dd, 5, 0, 0));
}

export async function getShopeeOrderDetail(orderSn: string, credentials: ShopeeStoreCredentials): Promise<ShopeeOrderDetail> {
  const response = await callShopeeApi(
    "GET",
    "/api/v2/order/get_order_detail",
    { order_sn_list: orderSn, response_optional_fields: "item_list,total_amount,order_status,create_time" },
    null,
    credentials
  );

  const data = response.data;
  console.log(`[shopeeOrders] raw order detail response for ${orderSn}:`, JSON.stringify(data));

  if (data?.error) {
    console.warn(`[shopeeOrders] order detail request failed for ${orderSn}: ${data.message ?? data.error}`);
    return { lineItems: [], createdAt: shopeeOrderDateFromSn(orderSn) };
  }

  const order = data?.response?.order_list?.[0];
  if (!order) {
    console.warn(`[shopeeOrders] no order found for order_sn ${orderSn}`);
    return { lineItems: [], createdAt: shopeeOrderDateFromSn(orderSn) };
  }

  const items = order.item_list ?? [];
  const results: OrderLineItem[] = [];

  for (const item of items) {
    const sellerSku = item.model_sku || item.item_sku;
    const quantity = Number(item.model_quantity_purchased ?? 1);
    const unitPrice = Number(item.model_discounted_price ?? item.model_original_price ?? 0);
    const originalPrice = Number(item.model_original_price ?? unitPrice);

    if (!sellerSku) {
      console.warn(`[shopeeOrders] item missing sku for order ${orderSn}:`, JSON.stringify(item));
      continue;
    }

    if (!unitPrice) {
      console.warn(`[shopeeOrders] could not resolve a unit price for SKU ${sellerSku} on order ${orderSn}:`, JSON.stringify(item));
    }

    results.push({
      sellerSku,
      quantity,
      unitPrice,
      originalPrice,
      productName: item.item_name,
      variantName: item.model_name,
    });
  }

  let createdAt: Date | undefined;
  if (order.create_time) {
    createdAt = new Date(order.create_time * 1000);
  } else {
    createdAt = shopeeOrderDateFromSn(orderSn);
    console.warn(
      `[shopeeOrders] ${orderSn} has no create_time; ` +
        (createdAt ? `falling back to the date in the order number (${createdAt.toISOString()})` : "and its order number isn't parseable — documents will be dated today")
    );
  }

  return { lineItems: results, createdAt };
}

export async function getShopeeOrderLineItems(orderSn: string, credentials: ShopeeStoreCredentials): Promise<OrderLineItem[]> {
  return (await getShopeeOrderDetail(orderSn, credentials)).lineItems;
}
