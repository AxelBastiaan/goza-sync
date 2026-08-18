import crypto from "crypto";
import axios, { AxiosResponse } from "axios";
import { getEnv, updateEnv } from "../env";

export let ACCURATE_APP_KEY = getEnv("ACCURATE_APP_KEY");
export let ACCURATE_SIGNATURE_SECRET = getEnv("ACCURATE_SIGNATURE_SECRET");
export let ACCURATE_API_TOKEN = getEnv("ACCURATE_API_TOKEN");
export let ACCURATE_HOST = getEnv("ACCURATE_HOST");

export function isAccurateConnected(): boolean {
  return Boolean(ACCURATE_APP_KEY && ACCURATE_SIGNATURE_SECRET && ACCURATE_API_TOKEN && ACCURATE_HOST);
}

// Saves the credentials a user pastes in from the Integrations UI, both to .env
// (so they survive a restart) and to these live bindings (so the change takes
// effect immediately, no restart needed) — same live-update pattern as ACCURATE_HOST
// below. Does NOT touch ACCURATE_HOST: the caller re-derives it via getAccurateHost()
// to confirm the credentials actually work before treating the connection as live.
export function setAccurateCredentials(appKey: string, signatureSecret: string, apiToken: string): void {
  ACCURATE_APP_KEY = appKey;
  ACCURATE_SIGNATURE_SECRET = signatureSecret;
  ACCURATE_API_TOKEN = apiToken;
  updateEnv("ACCURATE_APP_KEY", appKey);
  updateEnv("ACCURATE_SIGNATURE_SECRET", signatureSecret);
  updateEnv("ACCURATE_API_TOKEN", apiToken);
}

export function clearAccurateCredentials(): void {
  ACCURATE_APP_KEY = "";
  ACCURATE_SIGNATURE_SECRET = "";
  ACCURATE_API_TOKEN = "";
  ACCURATE_HOST = "";
  updateEnv("ACCURATE_APP_KEY", "");
  updateEnv("ACCURATE_SIGNATURE_SECRET", "");
  updateEnv("ACCURATE_API_TOKEN", "");
  updateEnv("ACCURATE_HOST", "");
}

// dd/mm/yyyy hh:nn:ss — one of Accurate's accepted formats. Accurate compares this
// against ITS OWN clock (Asia/Jakarta) and rejects anything more than 600s apart, so
// the timestamp must be Jakarta wall-clock time no matter where this process runs.
// Reading it off the host's local timezone silently broke every signed call in the
// Docker container, which runs UTC: 7 hours out, so 100% rejection.
function formatTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")}:${get("second")}`;
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
