import { Router, Request, Response } from "express";
import { db } from "../db";
import { getStoreById } from "../services/storesRepo";
import { fetchTikTokSkuMap, getAccurateItemByNo, AccurateItemData } from "../services/stockSync";
import { fetchShopeeSkuMap } from "../services/shopeeStockSync";
import { getMappingForMarketplaceSku, getMappingsForAccurateSku } from "../services/skuMappings";
import { mapWithConcurrency, withRetry } from "../services/concurrency";

const router = Router();

interface StoreSkuEntry {
  sku: string;
  // Marketplace product/listing name, used to guess a sensible default unit (e.g.
  // notebooks sold "buku tulis" are listed per-pack, not per-piece) — see
  // suggestUnitLevel() below.
  marketplaceName: string;
}

async function getStoreSkuList(store: { platform: string; credentials: any }): Promise<StoreSkuEntry[]> {
  if (store.platform === "tiktok") {
    const map = await fetchTikTokSkuMap(store.credentials);
    return [...map.entries()].map(([sku, matches]) => ({ sku, marketplaceName: matches[0]?.productName ?? "" }));
  }
  if (store.platform === "shopee") {
    const map = await fetchShopeeSkuMap(store.credentials);
    return [...map.entries()].map(([sku, matches]) => ({ sku, marketplaceName: matches[0]?.itemName ?? "" }));
  }
  throw new Error(`Unknown platform "${store.platform}"`);
}

// Books ("buku tulis") are conventionally sold per-pack rather than per-piece —
// default those to a PAK unit (if the Accurate item actually has one) instead of
// the base unit. Anything else keeps the existing unit-1 default.
function suggestUnitLevel(marketplaceName: string, units: AccurateItemData["units"]): number {
  if (!marketplaceName.toLowerCase().includes("buku tulis")) {
    return 1;
  }
  for (const level of [2, 3] as const) {
    if (units[level]?.name?.toUpperCase() === "PAK") {
      return level;
    }
  }
  return 1;
}

function availableUnitsOf(units: AccurateItemData["units"]): { level: number; name: string }[] {
  return ([1, 2, 3] as const)
    .filter((level) => units[level])
    .map((level) => ({ level, name: units[level]!.name }));
}

// Scans one store's full catalog for SKUs not yet mapped, and checks each remaining
// one against Accurate by exact SKU code (same matching convention as the existing
// default-mapping flow: marketplace SKU string === Accurate item's `no`).
router.post("/:storeId/scan", async (req: Request, res: Response) => {
  const storeId = Number(req.params.storeId);
  const store = getStoreById(storeId);
  if (!store) {
    return res.status(404).json({ error: `Store ${storeId} not found` });
  }

  try {
    const allEntries = await getStoreSkuList(store);
    const unmappedEntries = allEntries.filter((entry) => !getMappingForMarketplaceSku(entry.sku));

    // Accurate hard-caps at 8 parallel requests / 8 per second per token — a scan can
    // easily turn up dozens of unmapped SKUs, so this must not fire them all at once.
    // 160ms min spacing bounds the rate to ~6.25/sec regardless of response speed,
    // leaving headroom under the 8/sec cap for other Accurate calls happening
    // concurrently under the same token (e.g. the live order webhook flow).
    const results = await mapWithConcurrency(unmappedEntries, 6, async (entry) => {
      const item = await withRetry(() => getAccurateItemByNo(entry.sku));
      if (!item) {
        return { marketplaceSku: entry.sku, foundInAccurate: false };
      }
      return {
        marketplaceSku: entry.sku,
        foundInAccurate: true,
        stock: item.quantity,
        suggestedUnitLevel: suggestUnitLevel(entry.marketplaceName, item.units),
        availableUnits: availableUnitsOf(item.units),
      };
    }, 160);

    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Scan failed" });
  }
});

// Creates a mapping for each selected SKU at the chosen unit level — re-verifies
// against Accurate rather than trusting the scan results, since time may have passed.
router.post("/:storeId/commit", async (req: Request, res: Response) => {
  const storeId = Number(req.params.storeId);
  const store = getStoreById(storeId);
  if (!store) {
    return res.status(404).json({ error: `Store ${storeId} not found` });
  }

  const items = Array.isArray(req.body?.items) ? (req.body.items as { marketplaceSku: string; unitLevel: number }[]) : [];
  if (items.length === 0) {
    return res.status(400).json({ error: "items must be a non-empty array" });
  }

  const created: string[] = [];
  // "skipped" = benign, expected outcomes (nothing went wrong, there's just nothing
  // to do). "errors" = the lookup or write itself failed — worth surfacing
  // separately since these are the ones that might need retrying.
  const skipped: { marketplaceSku: string; reason: string }[] = [];
  const errors: { marketplaceSku: string; reason: string }[] = [];

  for (const { marketplaceSku: sku, unitLevel } of items) {
    if (getMappingForMarketplaceSku(sku)) {
      skipped.push({ marketplaceSku: sku, reason: "Already mapped" });
      continue;
    }

    let item;
    try {
      item = await withRetry(() => getAccurateItemByNo(sku));
    } catch (err: any) {
      errors.push({ marketplaceSku: sku, reason: err?.message ?? "Accurate lookup failed" });
      continue;
    }
    if (!item) {
      skipped.push({ marketplaceSku: sku, reason: "Not found in Accurate" });
      continue;
    }

    const resolvedUnitLevel = [1, 2, 3].includes(unitLevel) && (item.units as any)[unitLevel] ? unitLevel : 1;

    const isFirstMappingForThisAccurateSku = getMappingsForAccurateSku(sku).length === 0;

    try {
      db.prepare("INSERT INTO sku_mappings (accurate_sku, unit_level, marketplace_sku, is_default) VALUES (?, ?, ?, ?)").run(
        sku,
        resolvedUnitLevel,
        sku,
        isFirstMappingForThisAccurateSku ? 1 : 0
      );
      created.push(sku);
    } catch (err: any) {
      if (String(err?.code).startsWith("SQLITE_CONSTRAINT")) {
        skipped.push({ marketplaceSku: sku, reason: "Already mapped" });
      } else {
        errors.push({ marketplaceSku: sku, reason: err?.message ?? "Unknown error" });
      }
    }
  }

  res.json({ created, skipped, errors });
});

export default router;
