import express from "express";
import path from "path";
import { getEnv } from "./env";
import oauthRouter from "./routes/oauth";
import shopeeOauthRouter from "./routes/shopeeOauth";
import mappingsRouter from "./routes/mappings";
import accurateSkusRouter from "./routes/accurateSkus";
import syncRouter from "./routes/sync";
import accurateWebhookRouter from "./routes/accurateWebhook";
import tiktokWebhookRouter from "./routes/tiktokWebhook";
import settingsRouter from "./routes/settings";
import storesRouter from "./routes/stores";
import integrationsRouter from "./routes/integrations";
import importRouter from "./routes/import";
import { renewAccurateWebhook } from "./services/accurateWebhookRenewal";
import { renewAllShopeeStores } from "./services/shopeeAuth";

const app = express();
app.use(
  express.json({
    // Capture the raw body bytes for webhook signature verification (e.g. TikTok's
    // HMAC scheme signs the exact raw payload, not a re-serialized JSON.parse result).
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  })
);

app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/oauth", oauthRouter);
app.use("/shopee/oauth", shopeeOauthRouter);
app.use("/api/mappings", mappingsRouter);
app.use("/api/accurate-skus", accurateSkusRouter);
app.use("/api/sync", syncRouter);
app.use("/webhooks/accurate", accurateWebhookRouter);
app.use("/webhooks/tiktok", tiktokWebhookRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/stores", storesRouter);
app.use("/api/integrations", integrationsRouter);
app.use("/api/import", importRouter);

const PORT = Number(getEnv("PORT") || 8000);

app.listen(PORT, () => {
  console.log(`goza-sync server running on http://127.0.0.1:${PORT}`);
});

const WEBHOOK_RENEWAL_INTERVAL_MS = 3 * 24 * 60 * 60 * 1000; // every 3 days (max window is 7)

renewAccurateWebhook().catch((err) => console.error("[accurateWebhookRenewal] initial renew failed:", err.message));
setInterval(() => {
  renewAccurateWebhook().catch((err) => console.error("[accurateWebhookRenewal] renew failed:", err.message));
}, WEBHOOK_RENEWAL_INTERVAL_MS);

const SHOPEE_TOKEN_RENEWAL_INTERVAL_MS = 3.5 * 60 * 60 * 1000; // access tokens last ~4 hours

renewAllShopeeStores().catch((err) => console.error("[shopeeTokenRenewal] initial renew failed:", err.message));
setInterval(() => {
  renewAllShopeeStores().catch((err) => console.error("[shopeeTokenRenewal] renew failed:", err.message));
}, SHOPEE_TOKEN_RENEWAL_INTERVAL_MS);
