import { getEnv } from "../env";
import { callAccurateApi } from "./accurateClient";
import { callTikTokApi, TikTokStoreCredentials } from "./tiktokClient";
import { SkuMapping, getSkuMappings, getMappingsForAccurateSku } from "./skuMappings";
import { getTikTokStores, TikTokStoreRow } from "./storesRepo";
import { mapWithConcurrency, withRetry } from "./concurrency";

export type SyncStatus =
  | "synced"
  | "skipped_disabled"
  | "skipped_no_accurate"
  | "skipped_not_found"
  | "error";

export interface SyncResult {
  marketplaceSku: string | null;
  accurateSku: string;
  status: SyncStatus;
  quantity?: number;
  message?: string;
  storeId?: number;
  storeName?: string;
}

export interface UnitInfo {
  name: string;
  ratio: number; // ratio to Accurate's base unit1 (always 1 for unit1 itself)
}

export interface AccurateItemData {
  // Sourced from Accurate's own `availableToSell` (stock yang dapat dijual) — already
  // nets out stock committed to any open Sales Order across the whole business, not
  // just orders that came through this app. This is why no separate reservation
  // ledger is needed: Accurate itself is the authoritative, real-time source of
  // "what's actually free to sell," computed synchronously the moment a Sales Order
  // is saved.
  quantity: number; // base unit1 quantity, available-to-sell basis
  units: { 1: UnitInfo; 2?: UnitInfo; 3?: UnitInfo };
}

export interface TikTokSkuMatch {
  productId: string;
  skuId: string;
  productName: string;
}

const REQUIRED_ENV_VARS = ["ACCURATE_HOST", "ACCURATE_API_TOKEN"];

// Caps what's ever pushed to or shown as a marketplace's stock — real Accurate stock
// can run well into the hundreds of thousands, and the user doesn't want competitors
// reading that off a public listing. Caps the MAX only: real stock below this still
// shows/pushes as-is, so a genuine low-stock situation is never misrepresented as
// higher than reality (that would risk overselling). Configurable via .env since it's
// a business decision that may change, not a technical constant.
const MAX_DISPLAYED_STOCK = Number(getEnv("MAX_DISPLAYED_STOCK")) || 500;

export function capDisplayQuantity(quantity: number): number {
  return Math.min(quantity, MAX_DISPLAYED_STOCK);
}

// Single targeted lookup — Accurate's item/list.do supports an exact-match filter
// (confirmed live: filter.no.op=EQUAL&filter.no.val=<sku>), so a single item can be
// fetched directly in ~0.5s instead of sweeping the entire paginated catalog.
export async function getAccurateItemByNo(itemNo: string): Promise<AccurateItemData | undefined> {
  const response = await callAccurateApi("GET", "item/list.do", {
    fields: "id,name,no,availableToSell,unit1,unit2,unit3,ratio2,ratio3",
    "filter.no.op": "EQUAL",
    "filter.no.val": itemNo,
  });

  if (!response.data?.s) {
    throw new Error(`Accurate item lookup failed for ${itemNo}: ${JSON.stringify(response.data?.d ?? response.status)}`);
  }

  const items = (response.data?.d ?? []) as {
    no?: string;
    availableToSell?: number;
    unit1?: { name: string };
    unit2?: { name: string };
    unit3?: { name: string };
    ratio2?: number;
    ratio3?: number;
  }[];

  const item = items.find((i) => i.no === itemNo);
  if (!item) {
    return undefined;
  }

  const units: AccurateItemData["units"] = {
    1: { name: item.unit1?.name ?? "PCS", ratio: 1 },
  };
  if (item.unit2 && item.ratio2) {
    units[2] = { name: item.unit2.name, ratio: item.ratio2 };
  }
  if (item.unit3 && item.ratio3) {
    units[3] = { name: item.unit3.name, ratio: item.ratio3 };
  }

  return { quantity: item.availableToSell ?? 0, units };
}

// Fetches only the specific Accurate SKUs given (deduped), each via a targeted
// lookup in parallel — never sweeps the full catalog. Replaces the old
// fetchAccurateItemData() which paged through every item in Accurate regardless
// of how many were actually relevant.
export async function fetchAccurateItemDataFor(itemNos: string[]): Promise<Map<string, AccurateItemData>> {
  const uniqueNos = [...new Set(itemNos)];
  // Accurate hard-caps at 8 parallel requests / 8 per second per token — an unbounded
  // Promise.all over every SKU blows past that instantly once there's more than a
  // handful. The 160ms min spacing bounds the actual request rate to ~6.25/sec
  // regardless of how fast Accurate responds, leaving headroom under the 8/sec cap
  // for other Accurate calls happening concurrently under the same token (webhooks,
  // other sync runs) — concurrency alone can't guarantee that.
  const results = await mapWithConcurrency(uniqueNos, 6, (no) => withRetry(() => getAccurateItemByNo(no)), 160);

  const map = new Map<string, AccurateItemData>();
  uniqueNos.forEach((no, i) => {
    const data = results[i];
    if (data) {
      map.set(no, data);
    }
  });
  return map;
}

export async function fetchTikTokSkuMap(credentials: TikTokStoreCredentials): Promise<Map<string, TikTokSkuMatch[]>> {
  const map = new Map<string, TikTokSkuMatch[]>();
  let pageToken: string | undefined;

  do {
    const params: Record<string, string | number> = { page_size: 100 };
    if (pageToken) {
      params.page_token = pageToken;
    }

    const response = await callTikTokApi("POST", "/product/202309/products/search", params, {}, credentials);
    const data = response.data;

    if (data?.code !== 0) {
      throw new Error(`TikTok product search failed: ${data?.message ?? response.status}`);
    }

    const products = data?.data?.products ?? [];
    for (const product of products) {
      for (const sku of product.skus ?? []) {
        const sellerSku = sku.seller_sku;
        if (!sellerSku) continue;
        const existing = map.get(sellerSku) ?? [];
        existing.push({ productId: product.id, skuId: sku.id, productName: product.title ?? "" });
        map.set(sellerSku, existing);
      }
    }

    pageToken = data?.data?.next_page_token || undefined;
  } while (pageToken);

  return map;
}

export async function pushTikTokQuantity(credentials: TikTokStoreCredentials, productId: string, skuId: string, quantity: number): Promise<void> {
  const response = await callTikTokApi(
    "POST",
    `/product/202309/products/${productId}/inventory/update`,
    { version: "202309" },
    { skus: [{ id: skuId, inventory: [{ quantity }] }] },
    credentials
  );

  if (response.data?.code !== 0) {
    throw new Error(response.data?.message ?? `HTTP ${response.status}`);
  }
}

function requireCredentials(): void {
  const missing = REQUIRED_ENV_VARS.filter((key) => !getEnv(key));
  if (missing.length > 0) {
    throw new Error(
      `Missing credentials: ${missing.join(", ")}. Complete the OAuth / host-discovery flow first (see README).`
    );
  }
}

async function matchAndPush(
  store: TikTokStoreRow,
  mapping: SkuMapping,
  accurateItemData: Map<string, AccurateItemData>,
  tiktokSkuMap: Map<string, TikTokSkuMatch[]>
): Promise<SyncResult[]> {
  const { marketplaceSku, accurateSku, unitLevel } = mapping;
  const storeTag = { storeId: store.id, storeName: store.name };

  if (!marketplaceSku) {
    return [{ marketplaceSku, accurateSku, status: "skipped_disabled", message: "No marketplace SKU set for this mapping", ...storeTag }];
  }

  const itemData = accurateItemData.get(accurateSku);
  if (!itemData) {
    return [{ marketplaceSku, accurateSku, status: "skipped_no_accurate", message: "Not found in Accurate", ...storeTag }];
  }

  const unit = itemData.units[unitLevel];
  if (!unit) {
    return [{
      marketplaceSku,
      accurateSku,
      status: "error",
      message: `Accurate item has no unit level ${unitLevel} configured`,
      ...storeTag,
    }];
  }

  // itemData.quantity is already Accurate's availableToSell — net of every open
  // Sales Order — so no further subtraction is needed here.
  const displayQuantity = capDisplayQuantity(Math.floor(itemData.quantity / unit.ratio));

  const matches = tiktokSkuMap.get(marketplaceSku) ?? [];
  if (matches.length === 0) {
    return [{ marketplaceSku, accurateSku, status: "skipped_not_found", message: "Not found on TikTok", quantity: displayQuantity, ...storeTag }];
  }

  // A seller SKU can be listed on multiple TikTok products at once (e.g. the same
  // item relisted under different products) — push the same quantity to every one
  // of them rather than refusing when there's more than one match.
  const settled = await Promise.allSettled(
    matches.map((match) => pushTikTokQuantity(store.credentials, match.productId, match.skuId, displayQuantity))
  );

  return settled.map((outcome, i): SyncResult => {
    if (outcome.status === "fulfilled") {
      return { marketplaceSku, accurateSku, status: "synced", quantity: displayQuantity, ...storeTag };
    }
    const match = matches[i];
    const err: any = outcome.reason;
    return {
      marketplaceSku,
      accurateSku,
      status: "error",
      quantity: displayQuantity,
      message: `[product ${match.productId}/sku ${match.skuId}] ${err?.message ?? "Unknown error"}`,
      ...storeTag,
    };
  });
}

// Standalone sync for every TikTok SKU mapped to one Accurate item, used by the
// Accurate stock-change webhook (one Accurate item can back multiple TikTok
// listings at different pack sizes, so all of them need re-pushing, not just one).
// Loops over every connected TikTok store, not just one — a mapping's marketplace
// SKU is checked/pushed independently against each store's own catalog.
export async function syncAllMappingsForAccurateSku(accurateSku: string): Promise<SyncResult[]> {
  const mappings = getMappingsForAccurateSku(accurateSku);
  const stores = getTikTokStores();
  if (mappings.length === 0 || stores.length === 0) {
    return [];
  }

  requireCredentials();

  const accurateItemData = await fetchAccurateItemDataFor([accurateSku]);

  const results: SyncResult[] = [];
  for (const store of stores) {
    const tiktokSkuMap = await fetchTikTokSkuMap(store.credentials);
    for (const mapping of mappings) {
      results.push(...(await matchAndPush(store, mapping, accurateItemData, tiktokSkuMap)));
    }
  }
  return results;
}

export async function runStockSync(): Promise<SyncResult[]> {
  requireCredentials();

  const stores = getTikTokStores();
  if (stores.length === 0) {
    return [];
  }

  const mappings = getSkuMappings();
  const accurateSkus = [...new Set(mappings.map((m) => m.accurateSku))];
  const accurateItemData = await fetchAccurateItemDataFor(accurateSkus);

  const results: SyncResult[] = [];
  for (const store of stores) {
    const tiktokSkuMap = await fetchTikTokSkuMap(store.credentials);
    for (const mapping of mappings) {
      results.push(...(await matchAndPush(store, mapping, accurateItemData, tiktokSkuMap)));
    }
  }

  return results;
}
