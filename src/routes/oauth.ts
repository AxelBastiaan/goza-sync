import { Router, Request, Response } from "express";
import { updateEnv } from "../env";
import { exchangeTikTokToken, upsertTikTokStores } from "../services/tiktokAuth";

const router = Router();

router.get("/callback", async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  console.log("Received TikTok authorization code:", code);

  if (!code) {
    return res.redirect("/?integrate=tiktok&status=error&message=" + encodeURIComponent("No code received"));
  }

  updateEnv("AUTH_CODE", code);

  try {
    const tokens = await exchangeTikTokToken(code);
    updateEnv("ACCESS_TOKEN", tokens.accessToken);
    updateEnv("REFRESH_TOKEN", tokens.refreshToken);

    const count = await upsertTikTokStores(tokens);
    res.redirect(`/?integrate=tiktok&status=success&stores=${count}`);
  } catch (err: any) {
    console.error("[oauth] TikTok exchange/upsert failed:", err?.message ?? err);
    res.redirect("/?integrate=tiktok&status=error&message=" + encodeURIComponent(err?.message ?? "Unknown error"));
  }
});

export default router;
