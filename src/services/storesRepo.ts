import { db } from "../db";
import { TikTokStoreCredentials } from "./tiktokClient";
import { ShopeeStoreCredentials } from "./shopeeClient";

export interface TikTokStoreRow {
  id: number;
  name: string;
  credentials: TikTokStoreCredentials;
}

export interface ShopeeStoreRow {
  id: number;
  name: string;
  credentials: ShopeeStoreCredentials;
}

interface RawStoreRow {
  id: number;
  platform: string;
  name: string;
  credentials: string | null;
  platform_shop_id: string | null;
}

export function getTikTokStores(): TikTokStoreRow[] {
  const rows = db
    .prepare("SELECT id, name, credentials FROM stores WHERE platform = 'tiktok' AND credentials IS NOT NULL")
    .all() as { id: number; name: string; credentials: string }[];
  return rows.map((r) => ({ id: r.id, name: r.name, credentials: JSON.parse(r.credentials) }));
}

export function getShopeeStores(): ShopeeStoreRow[] {
  const rows = db
    .prepare("SELECT id, name, credentials FROM stores WHERE platform = 'shopee' AND credentials IS NOT NULL")
    .all() as { id: number; name: string; credentials: string }[];
  return rows.map((r) => ({ id: r.id, name: r.name, credentials: JSON.parse(r.credentials) }));
}

export function getTikTokStoreByShopId(shopId: string): TikTokStoreRow | undefined {
  const row = db
    .prepare("SELECT id, name, credentials FROM stores WHERE platform = 'tiktok' AND platform_shop_id = ? AND credentials IS NOT NULL")
    .get(shopId) as { id: number; name: string; credentials: string } | undefined;
  return row ? { id: row.id, name: row.name, credentials: JSON.parse(row.credentials) } : undefined;
}

export function getStoreById(id: number): { id: number; platform: string; name: string; credentials: any } | undefined {
  const row = db.prepare("SELECT * FROM stores WHERE id = ?").get(id) as RawStoreRow | undefined;
  if (!row || !row.credentials) return undefined;
  return { id: row.id, platform: row.platform, name: row.name, credentials: JSON.parse(row.credentials) };
}
