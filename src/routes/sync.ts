import { Router, Request, Response } from "express";
import { runStockSync } from "../services/stockSync";
import { runShopeeStockSync } from "../services/shopeeStockSync";

const router = Router();

router.post("/", async (_req: Request, res: Response) => {
  try {
    const results = await runStockSync();
    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Sync failed" });
  }
});

router.post("/shopee", async (_req: Request, res: Response) => {
  try {
    const results = await runShopeeStockSync();
    res.json(results);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Sync failed" });
  }
});

export default router;
