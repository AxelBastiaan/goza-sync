import express from "express";
import session from "express-session";
import path from "path";
import { getEnv } from "./env";
import { requireAuth } from "./middleware/requireAuth";
import { seedInitialUserIfNeeded } from "./services/auth";
import authRouter from "./routes/auth";
import oauthRouter from "./routes/oauth";
import shopeeOauthRouter from "./routes/shopeeOauth";
import mappingsRouter from "./routes/mappings";
import accurateSkusRouter from "./routes/accurateSkus";
import syncRouter from "./routes/sync";
import accurateWebhookRouter from "./routes/accurateWebhook";
import tiktokWebhookRouter from "./routes/tiktokWebhook";
import shopeeWebhookRouter from "./routes/shopeeWebhook";
import whatsappWebhookRouter from "./routes/whatsappWebhook";
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

const SESSION_SECRET = getEnv("SESSION_SECRET");
if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET is not set in .env");
}

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      // The app runs behind ngrok/a reverse proxy over HTTPS in every environment
      // it's actually used in (never plain http in practice), so this is safe to
      // require unconditionally rather than branching on NODE_ENV.
      secure: true,
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
  })
);
// Cookie's `secure: true` only gets sent back over a connection Express itself
// sees as HTTPS — behind ngrok that's actually plain HTTP to this process, with
// TLS terminated upstream. Trusting the proxy's X-Forwarded-Proto header is what
// makes req.secure (and therefore the cookie) work correctly here.
app.set("trust proxy", 1);

seedInitialUserIfNeeded("admin", "Goza2017");

app.use("/api/auth", authRouter);

// Gate the app shell itself so a signed-out visitor lands on the login page
// instead of a flash of the real UI — static assets (login.html, style.css,
// app.js) stay public since none of them expose data on their own.
app.get(["/", "/index.html"], requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use(express.static(path.join(__dirname, "..", "public")));

app.use("/oauth", oauthRouter);
app.use("/shopee/oauth", shopeeOauthRouter);
app.use("/api/mappings", requireAuth, mappingsRouter);
app.use("/api/accurate-skus", requireAuth, accurateSkusRouter);
app.use("/api/sync", requireAuth, syncRouter);
app.use("/webhooks/accurate", accurateWebhookRouter);
app.use("/webhooks/tiktok", tiktokWebhookRouter);
app.use("/webhooks/shopee", shopeeWebhookRouter);
app.use("/webhooks/whatsapp", whatsappWebhookRouter);
app.use("/api/settings", requireAuth, settingsRouter);
app.use("/api/stores", requireAuth, storesRouter);
app.use("/api/integrations", requireAuth, integrationsRouter);
app.use("/api/import", requireAuth, importRouter);

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
