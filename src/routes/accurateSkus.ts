import { Router, Request, Response } from "express";
import { db } from "../db";
import { getAccurateItemByNo, fetchAccurateItemDataFor, AccurateItemData } from "../services/stockSync";
import { getDistinctAccurateSkus, getMappingsForAccurateSku } from "../services/skuMappings";

const router = Router();

// Filling in stock means one rate-limited Accurate call per mapped SKU — with
// several hundred mappings that is minutes end to end, so a page refresh must
// not redo it from scratch. The ↻ button sends `?fresh=1` to force a live read.
const STOCK_CACHE_TTL_MS = 5 * 60 * 1000;

let stockCache: { skus: Set<string>; data: Map<string, AccurateItemData>; fetchedAt: number } | null = null;
let stockInFlight: Promise<Map<string, AccurateItemData>> | null = null;

function cachedItemData(skus: string[], fresh: boolean): Promise<Map<string, AccurateItemData>> {
  // A SKU missing from the cached run has no entry either way (not found in
  // Accurate looks the same as never asked for), so the cache is only usable
  // when every SKU we need was part of the run that built it.
  const usable =
    stockCache !== null &&
    Date.now() - stockCache.fetchedAt < STOCK_CACHE_TTL_MS &&
    skus.every((sku) => stockCache!.skus.has(sku));

  if (!fresh && usable) {
    return Promise.resolve(stockCache!.data);
  }
  // Coalesce concurrent callers onto one run rather than doubling the load.
  if (stockInFlight) {
    return stockInFlight;
  }

  stockInFlight = fetchAccurateItemDataFor(skus)
    .then((data) => {
      stockCache = { skus: new Set(skus), data, fetchedAt: Date.now() };
      return data;
    })
    .finally(() => {
      stockInFlight = null;
    });
  return stockInFlight;
}

// A newly added SKU is already looked up live by POST below, so fold it into the
// cache instead of invalidating (which would cost another full re-read).
function primeStockCache(accurateSku: string, item: AccurateItemData): void {
  if (!stockCache) return;
  stockCache.skus.add(accurateSku);
  stockCache.data.set(accurateSku, item);
}

// Whole-list endpoint: one call gets everything needed to render the accordion
// list AND seed the settings modal's unit dropdown (no separate per-item fetch).
// `?stock=skip` answers straight from the local DB without touching Accurate.
// The list page loads that first so the mappings render instantly, then asks
// again without the flag for the (much slower) live stock figures.
router.get("/", async (req: Request, res: Response) => {
  const accurateSkus = getDistinctAccurateSkus();
  const skipStock = req.query.stock === "skip";

  let accurateItemData = new Map<string, AccurateItemData>();
  if (!skipStock) {
    try {
      accurateItemData = await cachedItemData(accurateSkus, req.query.fresh === "1");
    } catch (err: any) {
      return res.status(500).json({ error: err?.message ?? "Failed to fetch Accurate item data" });
    }
  }

  const result = accurateSkus.map((accurateSku) => {
    const item = accurateItemData.get(accurateSku);
    const mappings = getMappingsForAccurateSku(accurateSku).map((m) => {
      const unit = item?.units[m.unitLevel];
      return {
        id: m.id,
        marketplaceSku: m.marketplaceSku,
        unitLevel: m.unitLevel,
        unitName: unit?.name ?? null,
        ratio: unit?.ratio ?? null,
        stock: unit && item ? Math.floor(item.quantity / unit.ratio) : null,
        isDefault: m.isDefault,
      };
    });

    return {
      accurateSku,
      stockKnown: !skipStock,
      stock: item?.quantity ?? null,
      units: item?.units ?? null,
      mappings,
    };
  });

  res.json(result);
});

// This is the one endpoint that intentionally does a live Accurate lookup — the
// explicit "search" moment the Add button's loading state represents.
router.post("/", async (req: Request, res: Response) => {
  const accurateSku = typeof req.body?.accurateSku === "string" ? req.body.accurateSku.trim() : "";

  if (!accurateSku) {
    return res.status(400).json({ error: "accurateSku is required" });
  }

  let item;
  try {
    item = await getAccurateItemByNo(accurateSku);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Failed to look up Accurate item" });
  }

  if (!item) {
    return res.status(400).json({ error: `Accurate SKU "${accurateSku}" not found` });
  }

  primeStockCache(accurateSku, item);

  try {
    db.prepare("INSERT INTO sku_mappings (accurate_sku, unit_level, marketplace_sku, is_default) VALUES (?, 1, ?, 1)").run(
      accurateSku,
      accurateSku
    );
  } catch (err: any) {
    if (String(err?.code).startsWith("SQLITE_CONSTRAINT")) {
      return res.status(409).json({ error: `"${accurateSku}" is already mapped, or that marketplace SKU is already used elsewhere` });
    }
    throw err;
  }

  res.status(201).json({ accurateSku });
});

// Adds a non-default mapping for an already-tracked Accurate SKU. Deliberately
// does NOT call Accurate — the unit level comes from the dropdown in the settings
// modal, which is only ever populated from data already fetched by GET / above,
// so there is nothing new to validate against Accurate here.
router.post("/:accurateSku/mappings", (req: Request, res: Response) => {
  const { accurateSku } = req.params;
  const marketplaceSkuRaw = req.body?.marketplaceSku;
  const marketplaceSku = typeof marketplaceSkuRaw === "string" && marketplaceSkuRaw.trim() ? marketplaceSkuRaw.trim() : null;
  const unitLevel = Number(req.body?.unitLevel);

  if (![1, 2, 3].includes(unitLevel)) {
    return res.status(400).json({ error: "unitLevel must be 1, 2, or 3" });
  }

  try {
    const result = db
      .prepare("INSERT INTO sku_mappings (accurate_sku, unit_level, marketplace_sku, is_default) VALUES (?, ?, ?, 0)")
      .run(accurateSku, unitLevel, marketplaceSku);
    res.status(201).json({ id: result.lastInsertRowid, accurateSku, unitLevel, marketplaceSku });
  } catch (err: any) {
    if (String(err?.code).startsWith("SQLITE_CONSTRAINT")) {
      return res.status(409).json({ error: `Marketplace SKU "${marketplaceSku}" is already mapped` });
    }
    throw err;
  }
});

export default router;
