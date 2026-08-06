import { Router, Request, Response } from "express";
import { getTikTokStores, getShopeeStores } from "../services/storesRepo";
import { buildTikTokAuthUrl } from "../services/tiktokAuth";
import { buildShopeeAuthUrl } from "../services/shopeeAuth";

const router = Router();

// One row per platform, each listing its actual connected stores (0-N) — a platform
// is never just "connected"/"not connected", since it can have multiple stores.
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

export default router;
