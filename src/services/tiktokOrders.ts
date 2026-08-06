import { callTikTokApi, TikTokStoreCredentials } from "./tiktokClient";

export interface OrderLineItem {
  sellerSku: string;
  quantity: number;
  unitPrice: number;
}

// NOTE: the exact response shape for order line items (field names for SKU/quantity)
// is unconfirmed — TikTok's webhook/order docs are behind a JS-rendered portal that
// couldn't be fetched during planning. This defensively tries a few likely field
// paths and logs the raw response so the real shape can be confirmed on first live use.
// Takes a specific store's credentials — an order belongs to exactly one shop, and
// with multiple TikTok stores connected there's no longer a single global token to
// assume; the caller (tiktokWebhook.ts) resolves which store from the webhook's shop_id.
export async function getOrderLineItems(orderId: string, credentials: TikTokStoreCredentials): Promise<OrderLineItem[]> {
  const response = await callTikTokApi("GET", "/order/202309/orders", { ids: orderId }, null, credentials);

  const data = response.data;
  console.log(`[tiktokOrders] raw order detail response for ${orderId}:`, JSON.stringify(data));

  if (data?.code !== 0) {
    console.warn(`[tiktokOrders] order detail request failed for ${orderId}: ${data?.message ?? response.status}`);
    return [];
  }

  const orders = data?.data?.orders ?? [];
  const order = orders[0];

  if (!order) {
    console.warn(`[tiktokOrders] no order found for id ${orderId}`);
    return [];
  }

  const lineItems = order.line_items ?? order.order_line_list ?? [];

  const results: OrderLineItem[] = [];
  for (const line of lineItems) {
    const sellerSku = line.seller_sku;
    const quantity = line.quantity ?? 1;
    // Field name unconfirmed — tries the most likely candidates from TikTok Shop's
    // documented line-item pricing fields; falls back to 0 and warns if none match,
    // so a Sales Order can still be created (with a price to fix manually) rather
    // than silently failing.
    const unitPrice = Number(line.sale_price ?? line.sku_sale_price ?? line.original_price ?? 0);

    if (!sellerSku) {
      console.warn(`[tiktokOrders] line item missing seller_sku for order ${orderId}:`, JSON.stringify(line));
      continue;
    }

    if (!unitPrice) {
      console.warn(`[tiktokOrders] could not resolve a unit price for SKU ${sellerSku} on order ${orderId}:`, JSON.stringify(line));
    }

    results.push({ sellerSku, quantity, unitPrice });
  }

  return results;
}
