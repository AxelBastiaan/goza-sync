import axios from "axios";
import { getSignedHeaders } from "./accurateClient";

// Per Accurate's Webhook API docs, renewal is a GET against the general
// account.accurate.id host (NOT the per-database ACCURATE_HOST used everywhere
// else). The docs' screenshot suggested only a Bearer token was needed, but a
// live call showed Accurate still requires the normal signed-request headers
// (X-Api-Timestamp/X-Api-Signature), same as every other Accurate API call.
// Each renewal extends the webhook's active window by up to 7 days; Accurate
// recommends renewing every 5-6 days.
export async function renewAccurateWebhook(): Promise<void> {
  const response = await axios.get("https://account.accurate.id/api/webhook-renew.do", {
    headers: getSignedHeaders(),
    validateStatus: () => true,
  });

  console.log("[accurateWebhookRenewal] renew response:", JSON.stringify(response.data));
}
