import crypto from "crypto";
import axios, { AxiosResponse } from "axios";
import { getEnv } from "../env";

// App-level credentials — shared across every Shopee shop authorized under this
// Partner app. Per-shop credentials (access token, shop id) are NOT module-level;
// they're passed into each call, since one app can have multiple shops authorized.
export const PARTNER_ID = getEnv("SHOPEE_PARTNER_ID");
export const PARTNER_KEY = getEnv("SHOPEE_PARTNER_KEY");

export interface ShopeeStoreCredentials {
  accessToken: string;
  shopId: string;
}

// Confirmed from Shopee's official "API calls" doc (2025-11-21): API-call base URLs
// (distinct from the browser-facing authorization URLs in shopeeGetAuthUrl.ts, which
// live on a different host). partner.shopeemobile.com is the production host "for
// developers who deployed their services near SG" (the relevant region for an
// Indonesian shop); the sandbox host is openplatform.sandbox.test-stable.shopee.sg —
// NOT partner.test-stable.shopeemobile.com, which was an earlier guess sourced from
// third-party SDK code and is wrong per the official doc.
const BASE_URL = getEnv("SHOPEE_BASE_URL") || "https://partner.shopeemobile.com";

// Shopee's v2 signature — confirmed from the official doc, not just third-party SDK
// source: HMAC-SHA256 hex digest, keyed by partner_key, over a plain concatenation
// (no separators) of partner_id + path + timestamp, plus access_token + shop_id for
// shop-authenticated ("Shop API") calls. Public APIs (no access_token/shop_id, e.g.
// token exchange/refresh) sign only partner_id + path + timestamp.
function signRequest(path: string, timestamp: number, credentials?: ShopeeStoreCredentials): string {
  let base = `${PARTNER_ID}${path}${timestamp}`;
  if (credentials) {
    base += `${credentials.accessToken}${credentials.shopId}`;
  }
  return crypto.createHmac("sha256", PARTNER_KEY).update(base).digest("hex");
}

export async function callShopeeApi(
  method: "GET" | "POST",
  path: string,
  extraParams: Record<string, string | number> = {},
  body: Record<string, unknown> | null = null,
  credentials?: ShopeeStoreCredentials
): Promise<AxiosResponse> {
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signRequest(path, timestamp, credentials);

  const params: Record<string, string | number> = {
    partner_id: PARTNER_ID,
    timestamp,
    sign,
    ...extraParams,
  };
  if (credentials) {
    params.access_token = credentials.accessToken;
    params.shop_id = credentials.shopId;
  }

  const url = BASE_URL + path;
  const headers = { "Content-Type": "application/json" };

  if (method === "GET") {
    return axios.get(url, { headers, params, validateStatus: () => true });
  }
  return axios.post(url, body ?? {}, { headers, params, validateStatus: () => true });
}
