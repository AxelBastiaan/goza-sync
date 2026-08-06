import crypto from "crypto";
import axios, { AxiosResponse } from "axios";
import { getEnv } from "../env";

// App-level credentials — shared across every TikTok store authorized under this
// Partner Center app. Per-store credentials (access token, shop cipher) are NOT
// module-level; they're passed into each call, since a single app can have multiple
// shops authorized, each with its own token.
export const APP_KEY = getEnv("APP_KEY");
export const APP_SECRET = getEnv("APP_SECRET");

export interface TikTokStoreCredentials {
  accessToken: string;
  shopCipher: string;
}

const BASE_URL = "https://open-api.tiktokglobalshop.com";

function signRequest(
  path: string,
  params: Record<string, string | number>,
  bodyStr: string = ""
): string {
  const sortedKeys = Object.keys(params).sort();
  const concatenated = sortedKeys.map((k) => `${k}${params[k]}`).join("");
  const baseString = `${APP_SECRET}${path}${concatenated}${bodyStr}${APP_SECRET}`;

  return crypto.createHmac("sha256", APP_SECRET).update(baseString).digest("hex");
}

// credentials is optional only for the small set of calls that happen before any
// shop is authorized yet (e.g. the initial /authorization/202309/shops fetch right
// after token exchange, which needs an access_token but has no shop_cipher yet).
export async function callTikTokApi(
  method: "GET" | "POST",
  path: string,
  extraParams: Record<string, string | number> = {},
  body: Record<string, unknown> | null = null,
  credentials?: TikTokStoreCredentials & { accessToken: string }
): Promise<AxiosResponse> {
  const accessToken = credentials?.accessToken;
  const shopCipher = credentials?.shopCipher;

  const params: Record<string, string | number> = {
    app_key: APP_KEY,
    timestamp: Math.floor(Date.now() / 1000),
    ...(shopCipher ? { shop_cipher: shopCipher } : {}),
    ...extraParams,
  };

  const bodyStr = body !== null ? JSON.stringify(body) : "";

  // sign BEFORE adding access_token — access_token must be excluded from the signed string
  params.sign = signRequest(path, params, bodyStr);

  // NOW add access_token, after signing — needed in the request but not the signature
  if (accessToken) {
    params.access_token = accessToken;
  }

  const headers = {
    "x-tts-access-token": accessToken ?? "",
    "Content-Type": "application/json",
  };

  const url = BASE_URL + path;

  if (method === "GET") {
    return axios.get(url, { headers, params, validateStatus: () => true });
  }
  return axios.post(url, bodyStr, { headers, params, validateStatus: () => true });
}

// Webhook signature scheme (confirmed from TikTok Shop's Webhooks Overview docs) is
// different from the outbound API-request signing above: HMAC-SHA256 over
// `app_key + raw_request_body`, keyed with app_secret, compared against the
// `Authorization` header (no "Bearer" prefix). Must use the exact raw body bytes —
// re-serializing JSON changes the signature. Shared app-level secret, unaffected by
// multi-store credentials.
export function verifyWebhookSignature(rawBody: Buffer | undefined, authorizationHeader: string | undefined): boolean {
  if (!rawBody || !authorizationHeader) {
    return false;
  }

  const base = APP_KEY + rawBody.toString("utf8");
  const expected = crypto.createHmac("sha256", APP_SECRET).update(base, "utf8").digest("hex");

  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(authorizationHeader, "utf8");

  return (
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}
