import axios from "axios";
import { db } from "../db";
import { getEnv } from "../env";
import { APP_KEY, APP_SECRET, callTikTokApi } from "./tiktokClient";

export interface TikTokTokenPair {
  accessToken: string;
  refreshToken: string;
}

// Confirmed directly by the user: https://services.tiktokshop.com/open/authorize?service_id=...
// No signing, no other required params — TikTok redirects to whatever redirect URL
// is configured against this service_id in Partner Center, not a URL param here.
// Re-using this same link is how "Integrate another store" works — the seller just
// authorizes a different shop (or logs in as a different seller).
export function buildTikTokAuthUrl(): string {
  const serviceId = getEnv("TIKTOK_SERVICE_ID");
  return `https://services.tiktokshop.com/open/authorize?service_id=${serviceId}`;
}

// Moved out of the exchangeToken.ts CLI script so both the manual script and the
// "Integrate" button's OAuth callback share the same logic.
export async function exchangeTikTokToken(authCode: string): Promise<TikTokTokenPair> {
  const response = await axios.get("https://auth.tiktok-shops.com/api/v2/token/get", {
    params: {
      app_key: APP_KEY,
      app_secret: APP_SECRET,
      auth_code: authCode,
      grant_type: "authorized_code",
    },
    validateStatus: () => true,
  });

  if (response.data?.code !== 0) {
    throw new Error(`TikTok token exchange failed: ${response.data?.message ?? response.status}`);
  }

  return { accessToken: response.data.data.access_token, refreshToken: response.data.data.refresh_token };
}

// TikTok access tokens expire (observed live: sync failed with "Expired
// credentials ... 'access_token' ... has expired"). Every store row already
// carries a refresh_token from the original authorization, but nothing was ever
// using it — Shopee had renewAllShopeeStores() on a timer and TikTok had no
// equivalent, so TikTok sync silently died once the first token aged out.
export async function refreshTikTokToken(refreshToken: string): Promise<TikTokTokenPair> {
  const response = await axios.get("https://auth.tiktok-shops.com/api/v2/token/refresh", {
    params: {
      app_key: APP_KEY,
      app_secret: APP_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    },
    validateStatus: () => true,
  });

  if (response.data?.code !== 0) {
    throw new Error(`TikTok token refresh failed: ${response.data?.message ?? response.status}`);
  }

  return { accessToken: response.data.data.access_token, refreshToken: response.data.data.refresh_token };
}

// Renews every connected TikTok store's access token in place, preserving each
// store's shopCipher (which is per-shop and unaffected by the token rotation).
export async function renewAllTikTokStores(): Promise<void> {
  if (!APP_KEY || !APP_SECRET) {
    return;
  }

  const stores = db.prepare("SELECT id, name, credentials FROM stores WHERE platform = 'tiktok' AND credentials IS NOT NULL").all() as {
    id: number;
    name: string;
    credentials: string;
  }[];

  for (const store of stores) {
    const creds = JSON.parse(store.credentials) as { accessToken: string; refreshToken: string; shopCipher: string };
    if (!creds.refreshToken) {
      console.error(`[tiktokTokenRenewal] store ${store.id} (${store.name}) has no refresh token — needs re-authorization`);
      continue;
    }

    try {
      const tokens = await refreshTikTokToken(creds.refreshToken);
      const updated = JSON.stringify({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        shopCipher: creds.shopCipher,
      });
      db.prepare("UPDATE stores SET credentials = ? WHERE id = ?").run(updated, store.id);
      console.log(`[tiktokTokenRenewal] store ${store.id} (${store.name}) renewed`);
    } catch (err: any) {
      console.error(`[tiktokTokenRenewal] store ${store.id} (${store.name}) failed:`, err?.message ?? err);
    }
  }
}

interface TikTokShop {
  shopId: string;
  cipher: string;
  name: string;
}

// A single authorization can grant more than one shop at once (a seller managing
// multiple TikTok shops under one login) — fetch every shop the new token can see,
// not just the first, so all of them get their own "stores" row. Field names beyond
// `cipher` (confirmed live via getShops.ts previously) are a best-effort guess at
// TikTok's usual shop-object shape (id/name) — unconfirmed until the first real
// multi-shop authorization is tested.
export async function fetchTikTokShops(accessToken: string): Promise<TikTokShop[]> {
  const response = await callTikTokApi("GET", "/authorization/202309/shops", {}, null, { accessToken, shopCipher: "" });
  if (response.data?.code !== 0) {
    throw new Error(`Failed to fetch authorized TikTok shops: ${response.data?.message ?? response.status}`);
  }

  const shops = (response.data?.data?.shops ?? []) as { id?: string; cipher?: string; name?: string; code?: string }[];
  return shops
    .filter((s): s is { id: string; cipher: string; name?: string; code?: string } => Boolean(s.id && s.cipher))
    .map((s) => ({ shopId: s.id, cipher: s.cipher, name: s.name ?? s.code ?? "TikTok Shop" }));
}

// Upserts one "stores" row per shop the token is authorized for, keyed by
// platform_shop_id so re-authorizing an already-connected shop updates its
// credentials instead of creating a duplicate row.
export async function upsertTikTokStores(tokens: TikTokTokenPair): Promise<number> {
  const shops = await fetchTikTokShops(tokens.accessToken);

  const existing = db.prepare("SELECT id, platform_shop_id FROM stores WHERE platform = 'tiktok'").all() as {
    id: number;
    platform_shop_id: string | null;
  }[];
  const byShopId = new Map(existing.filter((r) => r.platform_shop_id).map((r) => [r.platform_shop_id, r.id]));

  const insert = db.prepare("INSERT INTO stores (platform, name, credentials, platform_shop_id) VALUES ('tiktok', ?, ?, ?)");
  const update = db.prepare("UPDATE stores SET name = ?, credentials = ? WHERE id = ?");

  for (const shop of shops) {
    const credentials = JSON.stringify({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      shopCipher: shop.cipher,
    });
    const existingId = byShopId.get(shop.shopId);
    if (existingId) {
      update.run(shop.name, credentials, existingId);
    } else {
      insert.run(shop.name, credentials, shop.shopId);
    }
  }

  return shops.length;
}
