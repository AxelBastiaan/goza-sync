import { getEnv } from "../env";
import { db } from "../db";
import { callShopeeApi, PARTNER_ID } from "./shopeeClient";

export interface ShopeeTokenPair {
  accessToken: string;
  refreshToken: string;
}

// Shopee's current documented method (confirmed from the official "Authorization
// and Authentication" doc, 2026-07-24): a fixed authorization URL, no manual
// signing needed — just partner_id + auth_type + redirect_uri + response_type=code.
// Lives on a DIFFERENT host than the API-call host in shopeeClient.ts (open.shopee.com
// is only for the browser-facing authorization page). The redirect_uri's domain must
// match whatever's configured as the app's Test/Live Redirect URL Domain in the
// Console, or Shopee rejects it. Re-using this same link is how "Integrate another
// store" works — the seller just authorizes a different shop from their account.
export function buildShopeeAuthUrl(): string {
  const isSandbox = getEnv("SHOPEE_USE_SANDBOX") === "true";
  const authHost = isSandbox ? "https://open.sandbox.test-stable.shopee.com" : "https://open.shopee.com";
  const redirectUri = getEnv("SHOPEE_REDIRECT_URL") || "https://your-ngrok-domain/shopee/oauth/callback";

  return (
    `${authHost}/auth?partner_id=${PARTNER_ID}` +
    `&auth_type=seller` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code`
  );
}

// Moved out of the shopeeExchangeToken.ts CLI script so both the manual script and
// the "Integrate" button's OAuth callback share the same logic.
export async function exchangeShopeeToken(code: string, shopId: string): Promise<ShopeeTokenPair> {
  const response = await callShopeeApi(
    "POST",
    "/api/v2/auth/token/get",
    {},
    { code, shop_id: Number(shopId), partner_id: Number(PARTNER_ID) }
  );

  if (!response.data?.access_token) {
    throw new Error(`Shopee token exchange failed: ${response.data?.message ?? response.data?.error ?? response.status}`);
  }

  return { accessToken: response.data.access_token, refreshToken: response.data.refresh_token };
}

// Shopee's redirect already tells us the exact shop_id being authorized (unlike
// TikTok, which can grant several shops from one authorization) — one call, one
// store row. Upserted by platform_shop_id so re-authorizing an already-connected
// shop updates its credentials instead of creating a duplicate.
export async function upsertShopeeStore(shopId: string, tokens: ShopeeTokenPair): Promise<void> {
  let name = `Shopee Shop ${shopId}`;
  try {
    const infoResponse = await callShopeeApi("GET", "/api/v2/shop/get_shop_info", {}, null, {
      accessToken: tokens.accessToken,
      shopId,
    });
    if (infoResponse.data?.shop_name) {
      name = infoResponse.data.shop_name;
    }
  } catch {
    // best-effort — fall back to the generic name above
  }

  const credentials = JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, shopId });

  const existing = db
    .prepare("SELECT id FROM stores WHERE platform = 'shopee' AND platform_shop_id = ?")
    .get(shopId) as { id: number } | undefined;

  if (existing) {
    db.prepare("UPDATE stores SET name = ?, credentials = ? WHERE id = ?").run(name, credentials, existing.id);
  } else {
    db.prepare("INSERT INTO stores (platform, name, credentials, platform_shop_id) VALUES ('shopee', ?, ?, ?)").run(
      name,
      credentials,
      shopId
    );
  }
}

// Renews every connected Shopee store's access token independently — each store has
// its own refresh_token now (stored in the DB, not .env), unlike the earlier
// single-global-credential design.
export async function renewAllShopeeStores(): Promise<void> {
  if (!getEnv("SHOPEE_PARTNER_ID") || !getEnv("SHOPEE_PARTNER_KEY")) {
    return;
  }

  const stores = db.prepare("SELECT id, credentials FROM stores WHERE platform = 'shopee'").all() as {
    id: number;
    credentials: string;
  }[];

  for (const store of stores) {
    const creds = JSON.parse(store.credentials) as { accessToken: string; refreshToken: string; shopId: string };
    const response = await callShopeeApi(
      "POST",
      "/api/v2/auth/access_token/get",
      {},
      { refresh_token: creds.refreshToken, shop_id: Number(creds.shopId), partner_id: Number(PARTNER_ID) }
    );

    if (!response.data?.access_token) {
      console.error(`[shopeeTokenRenewal] store ${store.id} renew failed:`, response.data?.message ?? response.data);
      continue;
    }

    const updated = JSON.stringify({
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token,
      shopId: creds.shopId,
    });
    db.prepare("UPDATE stores SET credentials = ? WHERE id = ?").run(updated, store.id);
  }
}
