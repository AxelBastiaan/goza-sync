import { callTikTokApi, TikTokStoreCredentials } from "./tiktokClient";

export interface OrderLineItem {
  sellerSku: string;
  quantity: number;
  unitPrice: number;
  // The marketplace's own pre-promotion listed price for this line, before any
  // discount was applied — used as the "before discount" gross reference on the
  // Accurate documents (see accurateSalesFlow.ts), instead of Accurate's own
  // (potentially stale) item price.
  originalPrice: number;
}

// Reads the order's real current status directly from TikTok, rather than
// trusting whatever the last webhook we happened to receive said — used for
// reconciling orders where webhook delivery may have been missed entirely.
export async function getOrderStatus(orderId: string, credentials: TikTokStoreCredentials): Promise<string | undefined> {
  const response = await callTikTokApi("GET", "/order/202309/orders", { ids: orderId }, null, credentials);
  const data = response.data;
  if (data?.code !== 0) {
    console.warn(`[tiktokOrders] order status request failed for ${orderId}: ${data?.message ?? response.status}`);
    return undefined;
  }
  return data?.data?.orders?.[0]?.status;
}

export interface TikTokOrderDetail {
  lineItems: OrderLineItem[];
  // When the buyer actually placed the order. Used as the transDate on the
  // Accurate documents so a sale is booked in the period it really happened,
  // rather than whenever the webhook that triggered the write arrived — those
  // differ by days (order placed, then delivered/completed a week later), which
  // silently pushed revenue into the wrong period. undefined if TikTok didn't
  // report create_time, in which case callers fall back to "now" as before.
  createdAt: Date | undefined;
}

// Takes a specific store's credentials — an order belongs to exactly one shop, and
// with multiple TikTok stores connected there's no longer a single global token to
// assume; the caller (tiktokWebhook.ts) resolves which store from the webhook's shop_id.
export async function getOrderDetail(orderId: string, credentials: TikTokStoreCredentials): Promise<TikTokOrderDetail> {
  const response = await callTikTokApi("GET", "/order/202309/orders", { ids: orderId }, null, credentials);

  const data = response.data;
  console.log(`[tiktokOrders] raw order detail response for ${orderId}:`, JSON.stringify(data));

  if (data?.code !== 0) {
    console.warn(`[tiktokOrders] order detail request failed for ${orderId}: ${data?.message ?? response.status}`);
    return { lineItems: [], createdAt: undefined };
  }

  const orders = data?.data?.orders ?? [];
  const order = orders[0];

  if (!order) {
    console.warn(`[tiktokOrders] no order found for id ${orderId}`);
    return { lineItems: [], createdAt: undefined };
  }

  const lineItems = order.line_items ?? order.order_line_list ?? [];

  const results: OrderLineItem[] = [];
  for (const line of lineItems) {
    const sellerSku = line.seller_sku;
    // Each line_items entry represents exactly one unit (confirmed live — a 2x
    // purchase of the same SKU comes back as two separate entries with distinct
    // `id`s, not one entry with a quantity field), so this always resolves to 1.
    const quantity = line.quantity ?? 1;
    // Confirmed live against 4 real orders against the seller's own manually-booked
    // invoice amounts: the seller's actual revenue per line is
    // original_price - seller_discount, NOT `sale_price` (original_price minus BOTH
    // seller_discount and platform_discount). platform_discount is TikTok-funded, not
    // money the seller gave up, so it must not reduce what's recorded as revenue —
    // using sale_price here was silently underinvoicing every order by exactly its
    // platform_discount amount.
    const unitPrice = Number(line.original_price ?? 0) - Number(line.seller_discount ?? 0);
    const originalPrice = Number(line.original_price ?? 0);

    if (!sellerSku) {
      console.warn(`[tiktokOrders] line item missing seller_sku for order ${orderId}:`, JSON.stringify(line));
      continue;
    }

    if (!unitPrice) {
      console.warn(`[tiktokOrders] could not resolve a unit price for SKU ${sellerSku} on order ${orderId}:`, JSON.stringify(line));
    }

    results.push({ sellerSku, quantity, unitPrice, originalPrice });
  }

  return {
    lineItems: results,
    createdAt: order.create_time ? new Date(order.create_time * 1000) : undefined,
  };
}

export async function getOrderLineItems(orderId: string, credentials: TikTokStoreCredentials): Promise<OrderLineItem[]> {
  return (await getOrderDetail(orderId, credentials)).lineItems;
}
