import { Router, Request, Response } from "express";
import { getTikTokStores, getShopeeStores, deleteStore } from "../services/storesRepo";
import { buildTikTokAuthUrl } from "../services/tiktokAuth";
import { buildShopeeAuthUrl } from "../services/shopeeAuth";
import {
  getAccurateHost,
  isAccurateConnected,
  setAccurateCredentials,
  clearAccurateCredentials,
} from "../services/accurateClient";

const router = Router();

// One row per platform, each listing its actual connected stores (0-N) — a platform
// is never just "connected"/"not connected", since it can have multiple stores.
// Accurate is the odd one out: it's a single global connection (one Accurate
// company database per install), not a list of stores.
router.get("/", (_req: Request, res: Response) => {
  res.json([
    {
      platform: "tiktok",
      name: "TikTok Shop",
      stores: getTikTokStores().map((s) => ({ id: s.id, name: s.name })),
    },
    {
      platform: "shopee",
      name: "Shopee",
      stores: getShopeeStores().map((s) => ({ id: s.id, name: s.name })),
    },
    {
      platform: "accurate",
      name: "Accurate Online",
      connected: isAccurateConnected(),
    },
  ]);
});

router.get("/:platform/auth-url", (req: Request, res: Response) => {
  const { platform } = req.params;
  if (platform === "tiktok") {
    return res.json({ url: buildTikTokAuthUrl() });
  }
  if (platform === "shopee") {
    return res.json({ url: buildShopeeAuthUrl() });
  }
  res.status(400).json({ error: `Unknown platform "${platform}"` });
});

router.delete("/stores/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid store id" });
  }
  const deleted = deleteStore(id);
  if (!deleted) {
    return res.status(404).json({ error: "Store not found" });
  }
  res.json({ ok: true });
});

router.post("/accurate/connect", async (req: Request, res: Response) => {
  const appKey = String(req.body?.appKey ?? "").trim();
  const signatureSecret = String(req.body?.signatureSecret ?? "").trim();
  const apiToken = String(req.body?.apiToken ?? "").trim();

  if (!appKey || !signatureSecret || !apiToken) {
    return res.status(400).json({ error: "App Key, Signature Secret, and API Token are all required" });
  }

  setAccurateCredentials(appKey, signatureSecret, apiToken);

  try {
    const response = await getAccurateHost();
    if (!response.data?.s || !response.data?.d?.database?.host) {
      return res.status(400).json({
        error: response.data?.d ?? "Accurate rejected these credentials",
      });
    }
    res.json({ ok: true, host: response.data.d.database.host });
  } catch (err: any) {
    res.status(502).json({ error: err?.message ?? "Failed to reach Accurate" });
  }
});

router.post("/accurate/disconnect", (_req: Request, res: Response) => {
  clearAccurateCredentials();
  res.json({ ok: true });
});

export default router;
