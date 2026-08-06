import { Router, Request, Response } from "express";
import { updateEnv } from "../env";
import { exchangeShopeeToken, upsertShopeeStore } from "../services/shopeeAuth";

const router = Router();

router.get("/callback", async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  const shopId = req.query.shop_id as string | undefined;
  console.log("Received Shopee authorization code:", code, "shop_id:", shopId);

  if (!code || !shopId) {
    return res.redirect("/?integrate=shopee&status=error&message=" + encodeURIComponent("No code/shop_id received"));
  }

  updateEnv("SHOPEE_AUTH_CODE", code);
  updateEnv("SHOPEE_SHOP_ID", shopId);

  try {
    const tokens = await exchangeShopeeToken(code, shopId);
    await upsertShopeeStore(shopId, tokens);
    res.redirect("/?integrate=shopee&status=success&stores=1");
  } catch (err: any) {
    console.error("[shopeeOauth] exchange/upsert failed:", err?.message ?? err);
    res.redirect("/?integrate=shopee&status=error&message=" + encodeURIComponent(err?.message ?? "Unknown error"));
  }
});

export default router;
