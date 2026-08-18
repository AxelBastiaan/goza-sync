import crypto from "crypto";
import axios, { AxiosResponse } from "axios";
import { getEnv } from "../env";

// App-level credentials — shared across every Shopee shop authorized under this
// Partner app. Per-shop credentials (access token, shop id) are NOT module-level;
// they're passed into each call, since one app can have multiple shops authorized.
export const PARTNER_ID = getEnv("SHOPEE_PARTNER_ID");
export const PARTNER_KEY = getEnv("SHOPEE_PARTNER_KEY");
// Separate key from PARTNER_KEY above — Shopee issues this specifically to sign
// incoming push/webhook payloads, distinct from the key that signs our outgoing
// API calls. Configured in Partner Center under Live Push Setting.
const PUSH_PARTNER_KEY = getEnv("SHOPEE_PUSH_PARTNER_KEY");
// Must exactly match what's registered as the Live Call Back URL in Partner
// Center — Shopee signs against that literal string, not whatever the request
// happens to report (which can differ if proxy headers aren't trusted).
const WEBHOOK_URL = getEnv("SHOPEE_WEBHOOK_URL");

// Shopee's documented push signature scheme: HMAC-SHA256(url + raw_body, push_partner_key),
// hex digest, sent as the "Authorization" header. Mirrors verifyWebhookSignature() in
// tiktokClient.ts but with a different base-string shape (url+body vs appkey+body).
export function verifyShopeeWebhookSignature(rawBody: Buffer | undefined, authorizationHeader: string | undefined): boolean {
  if (!rawBody || !authorizationHeader || !PUSH_PARTNER_KEY || !WEBHOOK_URL) {
    return false;
  }

  const base = WEBHOOK_URL + rawBody.toString("utf8");
  const expected = crypto.createHmac("sha256", PUSH_PARTNER_KEY).update(base, "utf8").digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(authorizationHeader, "utf8");

  return expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export interface ShopeeStoreCredentials {
  accessToken: string;
  shopId: string;
}

// Confirmed from Shopee's official "API calls" doc (2025-11-21): API-call base URLs
// (distinct from the browser-facing authorization URLs in shopeeAuth.ts, which live
// on a different host). partner.shopeemobile.com is the production host "for
// developers who deployed their services near SG" (the relevant region for an
// Indonesian shop); the sandbox host is openplatform.sandbox.test-stable.shopee.sg —
// NOT partner.test-stable.shopeemobile.com, which was an earlier guess sourced from
// third-party SDK code and is wrong per the official doc.
//
// Driven by the same SHOPEE_USE_SANDBOX flag as buildShopeeAuthUrl() in shopeeAuth.ts
// — both the browser auth host and this API host must switch together, or requests
// end up signed/sent for the wrong environment. SHOPEE_BASE_URL remains as a manual
// override for edge cases, but normally only SHOPEE_USE_SANDBOX needs to be set.
const BASE_URL =
  getEnv("SHOPEE_BASE_URL") ||
  (getEnv("SHOPEE_USE_SANDBOX") === "true" ? "https://openplatform.sandbox.test-stable.shopee.sg" : "https://partner.shopeemobile.com");

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
