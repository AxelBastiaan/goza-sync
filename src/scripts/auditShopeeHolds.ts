// Read-only counterpart to auditCampaignHolds.ts, for Shopee. Shopee's stock model
// is not TikTok's — it exposes reserved stock and promotion state on the model
// record — so rather than assume the TikTok campaign-lock explanation carries over,
// this dumps the raw model/base-info payload for the SKUs given, plus what the sync
// would push, and lets the actual fields settle it. Nothing is written.
//
// Usage: npx ts-node src/scripts/auditShopeeHolds.ts GZ-179-9 GZ-179-D ...
import { callShopeeApi } from "../services/shopeeClient";
import { getShopeeStores } from "../services/storesRepo";
import { getMappingForMarketplaceSku } from "../services/skuMappings";
import { fetchAccurateItemDataFor, capDisplayQuantity } from "../services/stockSync";

async function main() {
  const targets = new Set(process.argv.slice(2));
  if (targets.size === 0) {
    console.error("Usage: ts-node src/scripts/auditShopeeHolds.ts <sellerSku> [sellerSku...]");
    process.exit(1);
  }

  const store = getShopeeStores()[0];
  if (!store) {
    console.error("No Shopee store connected");
    process.exit(1);
  }
  console.log(`Shopee store: ${store.id}:${store.name}\n`);

  let offset = 0;
  const pageSize = 100;
  const found = new Set<string>();

  for (;;) {
    const listResponse = await callShopeeApi(
      "GET",
      "/api/v2/product/get_item_list",
      { offset, page_size: pageSize, item_status: "NORMAL" },
      null,
      store.credentials
    );
    if (listResponse.data?.error) {
      throw new Error(`get_item_list failed: ${listResponse.data.message ?? listResponse.data.error}`);
    }
    const items = (listResponse.data?.response?.item ?? []) as { item_id: number }[];
    if (items.length === 0) break;

    const baseInfo = new Map<number, any>();
    for (let i = 0; i < items.length; i += 50) {
      const chunk = items.slice(i, i + 50).map((it) => it.item_id);
      const response = await callShopeeApi(
        "GET",
        "/api/v2/product/get_item_base_info",
        { item_id_list: chunk.join(","), need_complaint_policy: "false", need_tax_info: "false" },
        null,
        store.credentials
      );
      for (const item of (response.data?.response?.item_list ?? []) as any[]) {
        baseInfo.set(item.item_id, item);
      }
    }

    for (const item of items) {
      const base = baseInfo.get(item.item_id);
      const modelResponse = await callShopeeApi("GET", "/api/v2/product/get_model_list", { item_id: item.item_id }, null, store.credentials);
      const models = (modelResponse.data?.response?.model ?? []) as any[];

      const candidates: { sku: string; raw: any }[] = [];
      if (models.length === 0) {
        if (base?.item_sku) candidates.push({ sku: base.item_sku, raw: { note: "no variations", stock_info_v2: base?.stock_info_v2 } });
      } else {
        for (const model of models) {
          if (model.model_sku) candidates.push({ sku: model.model_sku, raw: model });
        }
      }

      for (const candidate of candidates) {
        if (!targets.has(candidate.sku)) continue;
        found.add(candidate.sku);

        const mapping = getMappingForMarketplaceSku(candidate.sku);
        let pushLine = "no mapping in this app";
        if (mapping) {
          const accurate = await fetchAccurateItemDataFor([mapping.accurateSku]);
          const data = accurate.get(mapping.accurateSku);
          const unit = data?.units[mapping.unitLevel];
          pushLine = data && unit
            ? `Accurate ${mapping.accurateSku} availableToSell=${data.quantity} unit=${unit.name}/${unit.ratio} -> would push ${capDisplayQuantity(Math.floor(data.quantity / unit.ratio))}`
            : `Accurate ${mapping.accurateSku} not resolvable`;
        }

        console.log(`===== ${candidate.sku} =====`);
        console.log(`item_id=${item.item_id} item_status=${base?.item_status} item_name=${base?.item_name ?? ""}`);
        console.log(pushLine);
        console.log(JSON.stringify(candidate.raw, null, 2));
        console.log();
      }
    }

    if (!listResponse.data?.response?.has_next_page) break;
    offset += pageSize;
  }

  const missing = [...targets].filter((t) => !found.has(t));
  if (missing.length > 0) {
    console.log(`NOT FOUND in the Shopee catalog (status NORMAL): ${missing.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
