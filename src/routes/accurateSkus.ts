import { Router, Request, Response } from "express";
import { db } from "../db";
import { getAccurateItemByNo, fetchAccurateItemDataFor } from "../services/stockSync";
import { getDistinctAccurateSkus, getMappingsForAccurateSku } from "../services/skuMappings";

const router = Router();

// Whole-list endpoint: one call gets everything needed to render the accordion
// list AND seed the settings modal's unit dropdown (no separate per-item fetch).
router.get("/", async (_req: Request, res: Response) => {
  const accurateSkus = getDistinctAccurateSkus();

  let accurateItemData;
  try {
    accurateItemData = await fetchAccurateItemDataFor(accurateSkus);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Failed to fetch Accurate item data" });
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
