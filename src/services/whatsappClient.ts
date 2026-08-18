import crypto from "crypto";
import axios from "axios";
import { getEnv } from "../env";

// Single business-owned WhatsApp number, unlike TikTok/Shopee — no per-store
// credentials, just one app-level token/phone-number-id pair.
const ACCESS_TOKEN = getEnv("WHATSAPP_ACCESS_TOKEN");
const PHONE_NUMBER_ID = getEnv("WHATSAPP_PHONE_NUMBER_ID");
const APP_SECRET = getEnv("WHATSAPP_APP_SECRET");

const GRAPH_VERSION = "v23.0";
const BASE_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Cloud API wants full E.164 digits with no "+" (e.g. 6281234567890). Per Meta's
// docs, a number missing its country code doesn't fail — the business number's own
// country code gets silently prepended, misdelivering to a real but wrong recipient.
// Staff/customers here will typically be typed in local Indonesian format
// (08123456789), so that has to become 628123456789, not just have its "0" stripped.
function normalizeNumber(to: string): string {
  const digits = to.replace(/[^\d]/g, "");
  return digits.startsWith("0") ? "62" + digits.slice(1) : digits;
}

export async function sendTextMessage(to: string, body: string): Promise<void> {
  const response = await axios.post(
    `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: normalizeNumber(to),
      type: "text",
      text: { body },
    },
    {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      validateStatus: () => true,
    }
  );

  if (response.status >= 400) {
    throw new Error(`WhatsApp send failed (${response.status}): ${JSON.stringify(response.data)}`);
  }
}

// Template messages are required to message a customer outside the 24h "customer
// service window" (e.g. proactive tagihan/stock-opname reminders) — the template
// name/language must already be approved in Meta Business Manager before this works.
export async function sendTemplateMessage(
  to: string,
  templateName: string,
  languageCode: string = "id",
  components: Record<string, unknown>[] = []
): Promise<void> {
  const response = await axios.post(
    `${BASE_URL}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: normalizeNumber(to),
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components.length > 0 ? { components } : {}),
      },
    },
    {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
      validateStatus: () => true,
    }
  );

  if (response.status >= 400) {
    throw new Error(`WhatsApp template send failed (${response.status}): ${JSON.stringify(response.data)}`);
  }
}

// Meta signs webhook deliveries with the app secret via the X-Hub-Signature-256
// header ("sha256=<hex>"), HMAC over the exact raw body bytes.
export function verifyWebhookSignature(rawBody: Buffer | undefined, signatureHeader: string | undefined): boolean {
  if (!rawBody || !signatureHeader?.startsWith("sha256=")) {
    return false;
  }

  const expected = crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(signatureHeader.slice("sha256=".length), "utf8");

  return (
    expectedBuffer.length === receivedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}
