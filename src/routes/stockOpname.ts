import { Router, Request, Response } from "express";
import {
  ensureCycle,
  getTodayList,
  markDone,
  undoDone,
  getLogs,
  getCycleInfo,
  getTodayJakarta,
} from "../services/stockOpname";

const router = Router();

function parseSkus(body: unknown): string[] {
  const skus = (body as { skus?: unknown })?.skus;
  return Array.isArray(skus) ? skus.filter((s): s is string => typeof s === "string") : [];
}

router.get("/today", async (_req: Request, res: Response) => {
  try {
    await ensureCycle();
    res.json({ items: getTodayList(), cycle: getCycleInfo(), today: getTodayJakarta() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/complete", (req: Request, res: Response) => {
  const skus = parseSkus(req.body);
  if (skus.length === 0) {
    return res.status(400).json({ error: "skus must be a non-empty array of strings" });
  }
  markDone(skus);
  res.json({ items: getTodayList() });
});

router.post("/undo", (req: Request, res: Response) => {
  const skus = parseSkus(req.body);
  if (skus.length === 0) {
    return res.status(400).json({ error: "skus must be a non-empty array of strings" });
  }
  undoDone(skus);
  res.json({ items: getTodayList(), logs: getLogs() });
});

router.get("/logs", (_req: Request, res: Response) => {
  res.json({ logs: getLogs() });
});

export default router;
