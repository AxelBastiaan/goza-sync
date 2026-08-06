import { Router, Request, Response } from "express";
import { isLiveMode, setLiveMode } from "../services/settings";

const router = Router();

router.get("/live-mode", (_req: Request, res: Response) => {
  res.json({ live: isLiveMode() });
});

router.post("/live-mode", (req: Request, res: Response) => {
  const live = req.body?.live;

  if (typeof live !== "boolean") {
    return res.status(400).json({ error: "Body must be { live: boolean }" });
  }

  setLiveMode(live);
  console.log(`[settings] live mode set to ${live}`);
  res.json({ live });
});

export default router;
