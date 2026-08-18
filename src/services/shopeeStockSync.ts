import { getEnv } from "../env";
import { callShopeeApi, ShopeeStoreCredentials } from "./shopeeClient";
import { SkuMapping, getSkuMappings, getMappingsForAccurateSku } from "./skuMappings";
import { AccurateItemData, fetchAccurateItemDataFor, SyncResult, SyncStatus, capDisplayQuantity } from "./stockSync";
import { getShopeeStores, ShopeeStoreRow } from "./storesRepo";
import { withRetry } from "./concurrency";

export interface ShopeeSkuMatch {
  itemId: number;
  modelId: number;
  itemName: string;
}

const REQUIRED_ENV_VARS = ["SHOPEE_PARTNER_ID", "SHOPEE_PARTNER_KEY", "ACCURATE_HOST", "ACCURATE_API_TOKEN"];

function requireCredentials(): void {
  const missing = REQUIRED_ENV_VARS.filter((key) => !getEnv(key));
  if (missing.length > 0) {
    throw new Error(`Missing Shopee credentials: ${missing.join(", ")}. Complete the Shopee shop authorization flow first (see README).`);
  }
}

// No "search by SKU" endpoint exists on Shopee's side (unlike Accurate's
// filter.no.op=EQUAL) — resolving a seller SKU to (item_id, model_id) requires
// paging the full item list, then reading each item's models. Same shape as
// fetchTikTokSkuMap() in stockSync.ts (a full catalog sweep per sync run), so
// this isn't a new performance regression, just the same pattern on a second
// platform. UNCONFIRMED against a real shop until the first live call — treat
// field names below as a calibration test, not a sure thing.
export async function fetchShopeeSkuMap(credentials: ShopeeStoreCredentials): Promise<Map<string, ShopeeSkuMatch[]>> {
  const map = new Map<string, ShopeeSkuMatch[]>();
  let offset = 0;
  const pageSize = 100;

  for (;;) {
    const listResponse = await callShopeeApi(
      "GET",
      "/api/v2/product/get_item_list",
      { offset, page_size: pageSize, item_status: "NORMAL" },
      null,
      credentials
    );
    const listData = listResponse.data;

    if (listData?.error) {
      throw new Error(`Shopee get_item_list failed: ${listData.message ?? listData.error}`);
    }

    const items = (listData?.response?.item ?? []) as { item_id: number }[];
    if (items.length === 0) {
      break;
    }

    // get_item_list doesn't return item_name/item_sku — a separate get_item_base_info
    // call (max 50 ids per request) resolves both. Confirmed live: an item with no
    // variations (has_model: false) carries its SKU directly here as item_sku, with
    // get_model_list returning an empty model array for it — so this is also the
    // fallback SKU source for non-variant items, not just a name lookup.
    const itemBaseInfo = new Map<number, { name: string; sku?: string }>();
    for (let i = 0; i < items.length; i += 50) {
      const chunk = items.slice(i, i + 50).map((it) => it.item_id);
      const baseInfoResponse = await callShopeeApi("GET", "/api/v2/product/get_item_base_info", { item_id_list: chunk.join(",") }, null, credentials);
      const baseInfoData = baseInfoResponse.data;
      if (baseInfoData?.error) continue;
      for (const item of (baseInfoData?.response?.item_list ?? []) as { item_id: number; item_name?: string; item_sku?: string }[]) {
        itemBaseInfo.set(item.item_id, { name: item.item_name ?? "", sku: item.item_sku });
      }
    }

    await Promise.all(
      items.map(async (item) => {
        const modelResponse = await callShopeeApi("GET", "/api/v2/product/get_model_list", { item_id: item.item_id }, null, credentials);
        const modelData = modelResponse.data;
        if (modelData?.error) {
          return; // skip items whose model list fails to load rather than aborting the whole sweep
        }

        const itemName = itemBaseInfo.get(item.item_id)?.name ?? "";
        const models = (modelData?.response?.model ?? []) as { model_id: number; model_sku?: string }[];

        if (models.length === 0) {
          // No variations — the item's own item_sku is what a seller actually set,
          // and model_id 0 is Shopee's documented convention for updating stock on
          // a non-variant item (confirmed live).
          const sellerSku = itemBaseInfo.get(item.item_id)?.sku;
          if (sellerSku) {
            const existing = map.get(sellerSku) ?? [];
            existing.push({ itemId: item.item_id, modelId: 0, itemName });
            map.set(sellerSku, existing);
          }
          return;
        }

        for (const model of models) {
          const sellerSku = model.model_sku;
          if (!sellerSku) continue;
          const existing = map.get(sellerSku) ?? [];
          existing.push({ itemId: item.item_id, modelId: model.model_id, itemName });
          map.set(sellerSku, existing);
        }
      })
    );

    const hasNextPage = listData?.response?.has_next_page;
    if (!hasNextPage) {
      break;
    }
    offset += pageSize;
  }

  return map;
}

export async function pushShopeeQuantity(credentials: ShopeeStoreCredentials, itemId: number, modelId: number, quantity: number): Promise<void> {
  // A bulk sync pushes dozens of these in quick succession — an earlier live run
  // showed 16/221 fail with a generic "Update stock failed" error that then
  // succeeded instantly on manual retry (confirmed: same item/model, no other
  // change), consistent with transient rate-limiting rather than a real per-item
  // problem. Retrying here absorbs that instead of surfacing a false failure.
  await withRetry(async () => {
    const response = await callShopeeApi(
      "POST",
      "/api/v2/product/update_stock",
      {},
      { item_id: itemId, stock_list: [{ model_id: modelId, seller_stock: [{ stock: quantity }] }] },
      credentials
    );

    if (response.data?.error) {
      throw new Error(response.data.message ?? response.data.error);
    }

    const failure = response.data?.response?.failure_list?.[0];
    if (failure) {
      throw new Error(failure.failed_reason ?? failure.failed_msg ?? "Update stock failed, please check failure_list for detailed reason");
    }
  });
}

function matchAndPush(
  store: ShopeeStoreRow,
  mapping: SkuMapping,
  accurateItemData: Map<string, AccurateItemData>,
  shopeeSkuMap: Map<string, ShopeeSkuMatch[]>
): Promise<SyncResult[]> {
  const { marketplaceSku, accurateSku, unitLevel } = mapping;
  const storeTag = { storeId: store.id, storeName: store.name };

  if (!marketplaceSku) {
    return Promise.resolve([{ marketplaceSku, accurateSku, status: "skipped_disabled" as SyncStatus, message: "No marketplace SKU set for this mapping", ...storeTag }]);
  }

  const itemData = accurateItemData.get(accurateSku);
  if (!itemData) {
    return Promise.resolve([{ marketplaceSku, accurateSku, status: "skipped_no_accurate" as SyncStatus, message: "Not found in Accurate", ...storeTag }]);
  }

  const unit = itemData.units[unitLevel];
  if (!unit) {
    return Promise.resolve([{
      marketplaceSku,
      accurateSku,
      status: "error" as SyncStatus,
      message: `Accurate item has no unit level ${unitLevel} configured`,
      ...storeTag,
    }]);
  }

  // itemData.quantity is already Accurate's availableToSell — net of every open
  // Sales Order — so no further subtraction is needed here.
  const displayQuantity = capDisplayQuantity(Math.floor(itemData.quantity / unit.ratio));

  const matches = shopeeSkuMap.get(marketplaceSku) ?? [];
  if (matches.length === 0) {
    return Promise.resolve([{ marketplaceSku, accurateSku, status: "skipped_not_found" as SyncStatus, message: "Not found on Shopee", quantity: displayQuantity, ...storeTag }]);
  }

  return Promise.allSettled(matches.map((match) => pushShopeeQuantity(store.credentials, match.itemId, match.modelId, displayQuantity))).then((settled) =>
    settled.map((outcome, i): SyncResult => {
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
        message: `[item ${match.itemId}/model ${match.modelId}] ${err?.message ?? "Unknown error"}`,
        ...storeTag,
      };
    })
  );
}

export async function runShopeeStockSync(): Promise<SyncResult[]> {
  requireCredentials();

  const stores = getShopeeStores();
  if (stores.length === 0) {
    return [];
  }

  const mappings = getSkuMappings();
  const accurateSkus = [...new Set(mappings.map((m) => m.accurateSku))];
  const accurateItemData = await fetchAccurateItemDataFor(accurateSkus);

  const results: SyncResult[] = [];
  for (const store of stores) {
    const shopeeSkuMap = await fetchShopeeSkuMap(store.credentials);
    for (const mapping of mappings) {
      results.push(...(await matchAndPush(store, mapping, accurateItemData, shopeeSkuMap)));
    }
  }

  return results;
}

export async function syncAllMappingsForAccurateSkuShopee(accurateSku: string): Promise<SyncResult[]> {
  const mappings = getMappingsForAccurateSku(accurateSku);
  const stores = getShopeeStores();
  if (mappings.length === 0 || stores.length === 0) {
    return [];
  }

  requireCredentials();

  const accurateItemData = await fetchAccurateItemDataFor([accurateSku]);

  const results: SyncResult[] = [];
  for (const store of stores) {
    const shopeeSkuMap = await fetchShopeeSkuMap(store.credentials);
    for (const mapping of mappings) {
      results.push(...(await matchAndPush(store, mapping, accurateItemData, shopeeSkuMap)));
    }
  }
  return results;
}
