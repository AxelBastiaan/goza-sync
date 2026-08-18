import { callShopeeApi, ShopeeStoreCredentials } from "./shopeeClient";
import { OrderLineItem } from "./tiktokOrders";

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
export async function getShopeeOrderLineItems(orderSn: string, credentials: ShopeeStoreCredentials): Promise<OrderLineItem[]> {
  const response = await callShopeeApi(
    "GET",
    "/api/v2/order/get_order_detail",
    { order_sn_list: orderSn, response_optional_fields: "item_list,total_amount,order_status" },
    null,
    credentials
  );

  const data = response.data;
  console.log(`[shopeeOrders] raw order detail response for ${orderSn}:`, JSON.stringify(data));

  if (data?.error) {
    console.warn(`[shopeeOrders] order detail request failed for ${orderSn}: ${data.message ?? data.error}`);
    return [];
  }

  const order = data?.response?.order_list?.[0];
  if (!order) {
    console.warn(`[shopeeOrders] no order found for order_sn ${orderSn}`);
    return [];
  }

  const items = order.item_list ?? [];
  const results: OrderLineItem[] = [];

  for (const item of items) {
    const sellerSku = item.model_sku || item.item_sku;
    const quantity = Number(item.model_quantity_purchased ?? 1);
    const unitPrice = Number(item.model_discounted_price ?? item.model_original_price ?? 0);

    if (!sellerSku) {
      console.warn(`[shopeeOrders] item missing sku for order ${orderSn}:`, JSON.stringify(item));
      continue;
    }

    if (!unitPrice) {
      console.warn(`[shopeeOrders] could not resolve a unit price for SKU ${sellerSku} on order ${orderSn}:`, JSON.stringify(item));
    }

    results.push({ sellerSku, quantity, unitPrice });
  }

  return results;
}
