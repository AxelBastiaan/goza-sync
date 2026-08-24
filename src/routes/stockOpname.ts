import { Router, Request, Response } from "express";
import { ensureCycle, getTodayList, markDone, getCycleInfo } from "../services/stockOpname";

const router = Router();

router.get("/today", async (_req: Request, res: Response) => {
  try {
    await ensureCycle();
    res.json({ items: getTodayList(), cycle: getCycleInfo() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/complete", (req: Request, res: Response) => {
  const skus = Array.isArray(req.body?.skus) ? req.body.skus.filter((s: unknown) => typeof s === "string") : [];
  if (skus.length === 0) {
    return res.status(400).json({ error: "skus must be a non-empty array of strings" });
  }
  markDone(skus);
  res.json({ items: getTodayList() });
});

export default router;
