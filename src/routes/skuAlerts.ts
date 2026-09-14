import { Router, Request, Response } from "express";
import { listSkuAlerts, countOpenSkuAlerts, setSkuAlertStatus, deleteSkuAlert } from "../services/skuAlerts";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  const alerts = listSkuAlerts();
  res.json({ alerts, openCount: countOpenSkuAlerts() });
});

// Just the number, for the sidebar badge — cheap enough to call on every page load
// without pulling the whole list.
router.get("/count", (_req: Request, res: Response) => {
  res.json({ openCount: countOpenSkuAlerts() });
});

// "Ignore" is for SKUs that genuinely shouldn't be mapped (a discontinued listing,
// a test order). It doesn't stop future orders on that SKU from reopening the alert
// — a new blocked order is new evidence, not a repeat of the dismissed one.
router.post("/:id/ignore", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!setSkuAlertStatus(id, "ignored")) {
    return res.status(404).json({ error: `No SKU alert with id ${id}` });
  }
  res.json({ alerts: listSkuAlerts(), openCount: countOpenSkuAlerts() });
});

router.post("/:id/reopen", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!setSkuAlertStatus(id, "open")) {
    return res.status(404).json({ error: `No SKU alert with id ${id}` });
  }
  res.json({ alerts: listSkuAlerts(), openCount: countOpenSkuAlerts() });
});

router.delete("/:id", (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!deleteSkuAlert(id)) {
    return res.status(404).json({ error: `No SKU alert with id ${id}` });
  }
  res.json({ alerts: listSkuAlerts(), openCount: countOpenSkuAlerts() });
});

export default router;
