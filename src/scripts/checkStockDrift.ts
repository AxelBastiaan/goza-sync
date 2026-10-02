// Read-only health check: does what each marketplace currently shows actually
// match what Accurate says is available to sell? Writes nothing anywhere.
//
//   node dist/scripts/checkStockDrift.js            # both platforms
//   node dist/scripts/checkStockDrift.js tiktok     # one of them
//
// The sync pushes unconditionally and reports "synced" whether or not the number
// had changed, so a successful sync run proves the push worked — not that the
// listings were right beforehand. This compares the two sides instead, which is
// what actually says whether the webhook-driven sync is keeping up on its own.
import { getSkuMappings } from "../services/skuMappings";
import { fetchAccurateItemDataFor, capDisplayQuantity } from "../services/stockSync";
import { getTikTokStores, getShopeeStores } from "../services/storesRepo";
import { callTikTokApi } from "../services/tiktokClient";
import { callShopeeApi } from "../services/shopeeClient";

interface Listing {
  sku: string;
  quantity: number;
  label: string;
}

// TikTok: inventory is per warehouse on each SKU of each product; a seller SKU can
// appear on more than one product, so every listing is reported separately.
async function fetchTikTokListings(): Promise<Listing[]> {
  const credentials = getTikTokStores()[0].credentials;
  const listings: Listing[] = [];
  let pageToken: string | undefined;

  do {
    const params: Record<string, string | number> = { page_size: 100 };
    if (pageToken) params.page_token = pageToken;
    const response = await callTikTokApi("POST", "/product/202309/products/search", params, {}, credentials);
    if (response.data?.code !== 0) throw new Error(`TikTok product search failed: ${response.data?.message}`);

    for (const product of response.data?.data?.products ?? []) {
      for (const sku of product.skus ?? []) {
        if (!sku.seller_sku) continue;
        const quantity = (sku.inventory ?? []).reduce((sum: number, inv: any) => sum + Number(inv.quantity ?? 0), 0);
        listings.push({ sku: sku.seller_sku, quantity, label: `product ${product.id}` });
      }
    }
    pageToken = response.data?.data?.next_page_token || undefined;
  } while (pageToken);

  return listings;
}

// Shopee: a non-variant item carries its SKU and stock on the item itself
// (has_model false, model_id 0 by convention); a variant item carries them per
// model. stock_info_v2.summary_info.total_available_stock is the number a buyer
// effectively sees, and is what pushShopeeQuantity sets.
async function fetchShopeeListings(): Promise<Listing[]> {
  const credentials = getShopeeStores()[0].credentials;
  const listings: Listing[] = [];
  let offset = 0;

  for (;;) {
    const list = await callShopeeApi(
      "GET",
      "/api/v2/product/get_item_list",
      { offset, page_size: 100, item_status: "NORMAL" },
      null,
      credentials
    );
    if (list.data?.error) throw new Error(`Shopee get_item_list failed: ${list.data.message ?? list.data.error}`);

    const items = (list.data?.response?.item ?? []) as { item_id: number }[];
    if (items.length === 0) break;

    for (let i = 0; i < items.length; i += 50) {
      const chunk = items.slice(i, i + 50).map((it) => it.item_id);
      const base = await callShopeeApi("GET", "/api/v2/product/get_item_base_info", { item_id_list: chunk.join(",") }, null, credentials);
      for (const item of (base.data?.response?.item_list ?? []) as any[]) {
        if (item.has_model) continue; // handled below, per model
        if (!item.item_sku) continue;
        listings.push({
          sku: item.item_sku,
          quantity: Number(item.stock_info_v2?.summary_info?.total_available_stock ?? 0),
          label: `item ${item.item_id}`,
        });
      }
    }

    for (const item of items) {
      const ml = await callShopeeApi("GET", "/api/v2/product/get_model_list", { item_id: item.item_id }, null, credentials);
      for (const model of (ml.data?.response?.model ?? []) as any[]) {
        if (!model.model_sku) continue;
        listings.push({
          sku: model.model_sku,
          quantity: Number(model.stock_info_v2?.summary_info?.total_available_stock ?? 0),
          label: `item ${item.item_id}/model ${model.model_id}`,
        });
      }
    }

    if (!list.data?.response?.has_next_page) break;
    offset += 100;
  }

  return listings;
}

async function report(platform: "tiktok" | "shopee"): Promise<void> {
  const mappings = getSkuMappings().filter((m) => m.marketplaceSku);
  const accurate = await fetchAccurateItemDataFor([...new Set(mappings.map((m) => m.accurateSku))]);

  // What the listing for each mapped SKU *should* read — the same arithmetic the
  // sync itself applies (availableToSell / unit ratio, capped for display).
  const expected = new Map<string, { quantity: number; accurateSku: string }>();
  for (const m of mappings) {
    const data = accurate.get(m.accurateSku);
    const unit = data?.units[m.unitLevel];
    if (!data || !unit) continue;
    expected.set(m.marketplaceSku!, { quantity: capDisplayQuantity(Math.floor(data.quantity / unit.ratio)), accurateSku: m.accurateSku });
  }

  const listings = platform === "tiktok" ? await fetchTikTokListings() : await fetchShopeeListings();

  let matched = 0;
  let unmapped = 0;
  const drifted: string[] = [];
  for (const listing of listings) {
    const want = expected.get(listing.sku);
    if (!want) {
      unmapped++;
      continue;
    }
    if (want.quantity === listing.quantity) matched++;
    else drifted.push(`${listing.sku}\t${listing.label}\tmarketplace=${listing.quantity}\taccurate=${want.quantity}\tdiff=${listing.quantity - want.quantity}`);
  }

  console.log(`\n=== ${platform} ===`);
  console.log(`listings checked: ${listings.length} (${unmapped} not mapped in this app, ignored)`);
  console.log(`in sync: ${matched}`);
  console.log(`drifted: ${drifted.length}`);
  for (const line of drifted.slice(0, 40)) console.log(`  ${line}`);
  if (drifted.length > 40) console.log(`  ... and ${drifted.length - 40} more`);
}

(async () => {
  const only = process.argv[2];
  if (only !== "shopee") await report("tiktok");
  if (only !== "tiktok") await report("shopee");
})().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
