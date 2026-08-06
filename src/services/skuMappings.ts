import { db } from "../db";

// A mapping ties an Accurate SKU + unit level to a generic marketplace SKU — the
// same SKU string is looked up across every connected store, regardless of
// platform (TikTok, Shopee, ...), rather than keeping one column per platform.
export interface SkuMapping {
  id: number;
  marketplaceSku: string | null;
  accurateSku: string;
  unitLevel: 1 | 2 | 3;
  isDefault: boolean;
}

interface SkuMappingRow {
  id: number;
  marketplace_sku: string | null;
  accurate_sku: string;
  unit_level: number;
  is_default: number;
}

function rowToMapping(row: SkuMappingRow): SkuMapping {
  return {
    id: row.id,
    marketplaceSku: row.marketplace_sku,
    accurateSku: row.accurate_sku,
    unitLevel: row.unit_level as 1 | 2 | 3,
    isDefault: row.is_default === 1,
  };
}

export function getSkuMappings(): SkuMapping[] {
  const rows = db.prepare("SELECT * FROM sku_mappings ORDER BY accurate_sku, unit_level").all() as SkuMappingRow[];
  return rows.map(rowToMapping);
}

export function getDistinctAccurateSkus(): string[] {
  const rows = db.prepare("SELECT DISTINCT accurate_sku FROM sku_mappings ORDER BY accurate_sku").all() as { accurate_sku: string }[];
  return rows.map((r) => r.accurate_sku);
}

export function getMappingsForAccurateSku(accurateSku: string): SkuMapping[] {
  const rows = db
    .prepare("SELECT * FROM sku_mappings WHERE accurate_sku = ? ORDER BY unit_level")
    .all(accurateSku) as SkuMappingRow[];
  return rows.map(rowToMapping);
}

export function getMappingForMarketplaceSku(marketplaceSku: string): SkuMapping | undefined {
  const row = db.prepare("SELECT * FROM sku_mappings WHERE marketplace_sku = ?").get(marketplaceSku) as SkuMappingRow | undefined;
  return row ? rowToMapping(row) : undefined;
}

export function getMappingById(id: number): SkuMapping | undefined {
  const row = db.prepare("SELECT * FROM sku_mappings WHERE id = ?").get(id) as SkuMappingRow | undefined;
  return row ? rowToMapping(row) : undefined;
}
