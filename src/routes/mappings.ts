import { Router, Request, Response } from "express";
import { db } from "../db";
import { getMappingById } from "../services/skuMappings";
import { fetchTikTokSkuMap, fetchAccurateItemDataFor, capDisplayQuantity } from "../services/stockSync";
import { fetchShopeeSkuMap } from "../services/shopeeStockSync";
import { getTikTokStores, getShopeeStores } from "../services/storesRepo";

const router = Router();

// Edits an existing mapping's marketplace SKU and/or unit level. Deliberately does
// NOT call Accurate — the unit dropdown in the settings modal is only ever populated
// from data already fetched by GET /api/accurate-skus, so there's nothing new to
// validate here; an invalid unit level would just surface as a graceful sync error
// later rather than corrupt anything.
router.patch("/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const mapping = getMappingById(id);

  if (!mapping) {
    return res.status(404).json({ error: `Mapping ${id} not found` });
  }

  const marketplaceSkuRaw = req.body?.marketplaceSku;
  const marketplaceSku = typeof marketplaceSkuRaw === "string" && marketplaceSkuRaw.trim() ? marketplaceSkuRaw.trim() : null;
  const unitLevel = req.body?.unitLevel !== undefined ? Number(req.body.unitLevel) : mapping.unitLevel;

  if (![1, 2, 3].includes(unitLevel)) {
    return res.status(400).json({ error: "unitLevel must be 1, 2, or 3" });
  }

  try {
    db.prepare("UPDATE sku_mappings SET marketplace_sku = ?, unit_level = ? WHERE id = ?").run(marketplaceSku, unitLevel, id);
  } catch (err: any) {
    if (String(err?.code).startsWith("SQLITE_CONSTRAINT")) {
      return res.status(409).json({ error: `Marketplace SKU "${marketplaceSku}" is already mapped` });
    }
    throw err;
  }

  res.json({ id, marketplaceSku, unitLevel });
});

router.delete("/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const mapping = getMappingById(id);

  if (!mapping) {
    return res.status(404).json({ error: `Mapping ${id} not found` });
  }

  db.prepare("DELETE FROM sku_mappings WHERE id = ?").run(id);
  res.status(204).end();
});

// Checked live, on click, not pre-computed on page load — this is a per-mapping
// on-demand lookup for the "N stores" popup, not something the main accordion list
// needs to pay for on every load. Iterates every REAL connected store (any number
// per platform) and checks whether this mapping's marketplace SKU is actually
// listed there right now, using that specific store's own credentials.
router.get("/:id/store-status", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const mapping = getMappingById(id);

  if (!mapping) {
    return res.status(404).json({ error: `Mapping ${id} not found` });
  }

  const tiktokStores = getTikTokStores();
  const shopeeStores = getShopeeStores();

  if (!mapping.marketplaceSku) {
    return res.json([
      ...tiktokStores.map((s) => ({ storeId: s.id, storeName: s.name, platform: "tiktok", found: false })),
      ...shopeeStores.map((s) => ({ storeId: s.id, storeName: s.name, platform: "shopee", found: false })),
    ]);
  }

  const marketplaceSku = mapping.marketplaceSku;
  const accurateItemData = await fetchAccurateItemDataFor([mapping.accurateSku]);
  const unit = accurateItemData.get(mapping.accurateSku)?.units[mapping.unitLevel];
  const baseQuantity = accurateItemData.get(mapping.accurateSku)?.quantity ?? 0;
  const quantity = unit ? capDisplayQuantity(Math.floor(baseQuantity / unit.ratio)) : undefined;

  const tiktokResults = await Promise.all(
    tiktokStores.map(async (store) => {
      const skuMap = await fetchTikTokSkuMap(store.credentials).catch(() => new Map());
      const found = (skuMap.get(marketplaceSku)?.length ?? 0) > 0;
      return { storeId: store.id, storeName: store.name, platform: "tiktok", found, quantity: found ? quantity : undefined };
    })
  );

  const shopeeResults = await Promise.all(
    shopeeStores.map(async (store) => {
      const skuMap = await fetchShopeeSkuMap(store.credentials).catch(() => new Map());
      const found = (skuMap.get(marketplaceSku)?.length ?? 0) > 0;
      return { storeId: store.id, storeName: store.name, platform: "shopee", found, quantity: found ? quantity : undefined };
    })
  );

  res.json([...tiktokResults, ...shopeeResults]);
});

export default router;
