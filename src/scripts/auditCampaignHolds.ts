// Read-only audit: for every mapped SKU, compares what the sync WOULD push
// (Accurate availableToSell, converted by unit ratio and capped) against TikTok's
// own inventory breakdown — specifically how much of the SKU's stock is locked into
// an active platform campaign (flash sale) versus freely adjustable in-shop stock.
//
// The point is to test one hypothesis: that the "Sync Now" failures are exactly the
// SKUs where the push would drop stock below the campaign-locked amount. Prints the
// full correlation table so the hypothesis can be confirmed or discarded on evidence
// rather than assumed. Nothing is written.
//
// Usage: npx ts-node src/scripts/auditCampaignHolds.ts
import { getSkuMappings } from "../services/skuMappings";
import { getTikTokStores } from "../services/storesRepo";
import { callTikTokApi } from "../services/tiktokClient";
import { fetchTikTokSkuMap, fetchAccurateItemDataFor, capDisplayQuantity } from "../services/stockSync";

interface InventoryBreakdown {
  sellerSku: string;
  totalAvailable: number;
  totalCommitted: number;
  inShop: number;
  campaigns: { name: string; quantity: number }[];
}

async function fetchInventoryBreakdowns(
  credentials: any,
  skuIds: string[]
): Promise<Map<string, InventoryBreakdown>> {
  const out = new Map<string, InventoryBreakdown>();

  // The endpoint accepts a batch of sku_ids; keep chunks modest to stay well inside
  // whatever the undocumented per-request cap is.
  for (let i = 0; i < skuIds.length; i += 20) {
    const chunk = skuIds.slice(i, i + 20);
    const response = await callTikTokApi("POST", "/product/202309/inventory/search", {}, { sku_ids: chunk }, credentials);
    if (response.data?.code !== 0) {
      console.warn(`inventory/search failed for chunk starting ${i}: ${response.data?.message}`);
      continue;
    }
    for (const product of response.data?.data?.inventory ?? []) {
      for (const sku of product.skus ?? []) {
        const dist = sku.total_available_inventory_distribution ?? {};
        out.set(sku.id, {
          sellerSku: sku.seller_sku,
          totalAvailable: sku.total_available_quantity ?? 0,
          totalCommitted: sku.total_committed_quantity ?? 0,
          inShop: dist.in_shop_inventory?.quantity ?? 0,
          campaigns: (dist.campaign_inventory ?? []).map((c: any) => ({
            name: c.campaign_name,
            quantity: c.quantity,
          })),
        });
      }
    }
  }

  return out;
}

async function main() {
  const store = getTikTokStores()[0];
  if (!store) {
    console.error("No TikTok store connected");
    process.exit(1);
  }

  const mappings = getSkuMappings();
  const accurateData = await fetchAccurateItemDataFor(mappings.map((m) => m.accurateSku));
  const skuMap = await fetchTikTokSkuMap(store.credentials);

  const allSkuIds: string[] = [];
  for (const matches of skuMap.values()) {
    for (const match of matches) allSkuIds.push(match.skuId);
  }
  const breakdowns = await fetchInventoryBreakdowns(store.credentials, allSkuIds);

  const rows: string[] = [];
  let campaignLocked = 0;
  let wouldDropBelowCampaign = 0;

  for (const mapping of mappings) {
    if (!mapping.marketplaceSku) continue;
    const item = accurateData.get(mapping.accurateSku);
    const matches = skuMap.get(mapping.marketplaceSku) ?? [];
    if (!item || matches.length === 0) continue;

    const unit = item.units[mapping.unitLevel];
    if (!unit) continue;
    const wouldPush = capDisplayQuantity(Math.floor(item.quantity / unit.ratio));

    for (const match of matches) {
      const bd = breakdowns.get(match.skuId);
      if (!bd) continue;
      const campaignQty = bd.campaigns.reduce((sum, c) => sum + c.quantity, 0);
      if (campaignQty > 0) campaignLocked++;
      const below = campaignQty > 0 && wouldPush < campaignQty;
      if (below) wouldDropBelowCampaign++;

      rows.push(
        [
          below ? "!!" : "  ",
          mapping.marketplaceSku.padEnd(14),
          `push=${String(wouldPush).padStart(4)}`,
          `tiktokAvail=${String(bd.totalAvailable).padStart(4)}`,
          `inShop=${String(bd.inShop).padStart(4)}`,
          `committed=${String(bd.totalCommitted).padStart(3)}`,
          `campaign=${String(campaignQty).padStart(3)}`,
          bd.campaigns.map((c) => c.name).join("|"),
        ].join("  ")
      );
    }
  }

  rows.sort();
  console.log(rows.join("\n"));
  console.log(
    `\nlistings checked: ${rows.length}  with campaign lock: ${campaignLocked}  ` +
      `where push < campaign lock: ${wouldDropBelowCampaign}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
