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
    return { lineItems: [], createdAt: undefined };
  }

  const order = data?.response?.order_list?.[0];
  if (!order) {
    console.warn(`[shopeeOrders] no order found for order_sn ${orderSn}`);
    return { lineItems: [], createdAt: undefined };
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

    results.push({ sellerSku, quantity, unitPrice, originalPrice });
  }

  return {
    lineItems: results,
    createdAt: order.create_time ? new Date(order.create_time * 1000) : undefined,
  };
}

export async function getShopeeOrderLineItems(orderSn: string, credentials: ShopeeStoreCredentials): Promise<OrderLineItem[]> {
  return (await getShopeeOrderDetail(orderSn, credentials)).lineItems;
}
