import { Router, Request, Response } from "express";
import { db } from "../db";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const stores = db.prepare("SELECT id, platform, name FROM stores ORDER BY id").all();
  res.json(stores);
});

export default router;
