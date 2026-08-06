import crypto from "crypto";
import axios, { AxiosResponse } from "axios";
import { getEnv, updateEnv } from "../env";

export const ACCURATE_APP_KEY = getEnv("ACCURATE_APP_KEY");
export const ACCURATE_SIGNATURE_SECRET = getEnv("ACCURATE_SIGNATURE_SECRET");
export const ACCURATE_API_TOKEN = getEnv("ACCURATE_API_TOKEN");
export let ACCURATE_HOST = getEnv("ACCURATE_HOST");

function formatTimestamp(date: Date): string {
  // dd/mm/yyyy hh:nn:ss — one of Accurate's accepted formats
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export function getSignedHeaders(): Record<string, string> {
  const timestamp = formatTimestamp(new Date());
  const signature = crypto
    .createHmac("sha256", ACCURATE_SIGNATURE_SECRET)
    .update(timestamp)
    .digest("base64");

  return {
    Authorization: `Bearer ${ACCURATE_API_TOKEN}`,
    "X-Api-Timestamp": timestamp,
    "X-Api-Signature": signature,
  };
}

export async function getAccurateHost(): Promise<AxiosResponse> {
  const response = await axios.post(
    "https://account.accurate.id/api/api-token.do",
    null,
    { headers: getSignedHeaders(), validateStatus: () => true }
  );

  const host = response.data?.d?.database?.host;
  if (response.data?.s && host) {
    updateEnv("ACCURATE_HOST", host);
    ACCURATE_HOST = host;
  }

  return response;
}

export async function callAccurateApi(
  method: "GET" | "POST",
  path: string,
  params: Record<string, string | number> = {},
  jsonBody: Record<string, unknown> | null = null
): Promise<AxiosResponse> {
  if (!ACCURATE_HOST) {
    throw new Error("ACCURATE_HOST not set yet — run getAccurateHost() first.");
  }

  const url = `${ACCURATE_HOST}/accurate/api/${path}`;
  const headers = getSignedHeaders();

  if (method === "GET") {
    return axios.get(url, { headers, params, validateStatus: () => true, maxRedirects: 5 });
  }
  return axios.post(url, jsonBody, {
    headers,
    params,
    validateStatus: () => true,
    maxRedirects: 5,
  });
}
