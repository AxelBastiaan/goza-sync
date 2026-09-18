import { Router, Request, Response } from "express";
import archiver from "archiver";
import { db } from "../db";
import "../types/session";
import { getTodayJakarta } from "../services/stockOpname";
import { getLastRefresh, refreshCustomer, refreshFromAccurate, refreshIfStale } from "../services/invoiceReminders/sync";
import {
  buildLetter,
  buildState,
  customerWhatsApp,
  getLog,
  goLive,
  markForwarded,
  markSent,
  pendingCount,
  salesTaskCustomerIds,
  salesWhatsApp,
  setIgnored,
  setSalespersonPhone,
  undo,
} from "../services/invoiceReminders/reminders";

const router = Router();

function username(req: Request): string | null {
  const row = db.prepare("SELECT username FROM users WHERE id = ?").get(req.session.userId) as { username: string } | undefined;
  return row?.username ?? null;
}

function customerId(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new Error("Invalid customer id");
  return id;
}

function fail(res: Response, err: unknown, status = 500): void {
  res.status(status).json({ error: (err as Error).message });
}

// Queues for the tab. Re-syncs from Accurate first when the data is over 30
// minutes old; if Accurate is unreachable the last known state is still shown,
// with the error alongside.
router.get("/state", async (_req: Request, res: Response) => {
  let refreshError: string | null = null;
  try {
    await refreshIfStale();
  } catch (err) {
    refreshError = (err as Error).message;
  }
  try {
    res.json({ ...buildState(), lastRefresh: getLastRefresh(), refreshError });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/refresh", async (_req: Request, res: Response) => {
  try {
    await refreshFromAccurate(true);
    res.json({ ...buildState(), lastRefresh: getLastRefresh(), refreshError: null });
  } catch (err) {
    fail(res, err);
  }
});

router.get("/count", (_req: Request, res: Response) => {
  try {
    res.json({ count: pendingCount() });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/go-live", async (_req: Request, res: Response) => {
  try {
    res.json(await goLive());
  } catch (err) {
    fail(res, err, 400);
  }
});

// Letter PDF. Re-checks the customer in Accurate first, so a letter never lists
// an invoice that was paid since the last sync. ?for=sales = the copy that goes
// to the salesperson (no "Pengingat ke-N" subject).
router.get("/customers/:id/letter.pdf", async (req: Request, res: Response) => {
  try {
    const id = customerId(req);
    await refreshCustomer(id);
    const { pdf, fileName } = await buildLetter(id, req.query.for === "sales");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.send(pdf);
  } catch (err) {
    fail(res, err, 409);
  }
});

// Prefilled WhatsApp message + wa.me link (null url = no usable number in
// Accurate). Also re-checks the customer in Accurate first.
router.post("/customers/:id/whatsapp", async (req: Request, res: Response) => {
  try {
    const id = customerId(req);
    await refreshCustomer(id);
    res.json(customerWhatsApp(id));
  } catch (err) {
    fail(res, err, 409);
  }
});

router.post("/customers/:id/sent", (req: Request, res: Response) => {
  try {
    res.json(markSent(customerId(req), username(req)));
  } catch (err) {
    fail(res, err, 409);
  }
});

router.post("/customers/:id/ignore", (req: Request, res: Response) => {
  try {
    const { ignored, note } = req.body as { ignored?: unknown; note?: unknown };
    setIgnored(customerId(req), ignored === true, typeof note === "string" && note.trim() ? note.trim() : null);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 400);
  }
});

router.post("/salespeople/:name/whatsapp", (req: Request, res: Response) => {
  try {
    res.json(salesWhatsApp(req.params.name));
  } catch (err) {
    fail(res, err, 409);
  }
});

// All of today's hand-off letters for one salesperson, zipped.
router.get("/salespeople/:name/letters.zip", async (req: Request, res: Response) => {
  try {
    const ids = salesTaskCustomerIds(req.params.name);
    if (!ids.length) throw new Error(`Nothing to forward to ${req.params.name} today.`);
    const letters = [];
    for (const id of ids) {
      await refreshCustomer(id);
      try {
        letters.push(await buildLetter(id, true));
      } catch {
        // Paid in the meantime — nothing to hand off for this customer.
      }
    }
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="Tagihan ${req.params.name} ${getTodayJakarta()}.zip"`);
    const zip = archiver("zip");
    zip.on("error", (err) => res.destroy(err));
    zip.pipe(res);
    for (const l of letters) zip.append(l.pdf, { name: l.fileName });
    await zip.finalize();
  } catch (err) {
    if (!res.headersSent) fail(res, err, 409);
  }
});

router.post("/salespeople/:name/forwarded", (req: Request, res: Response) => {
  try {
    res.json(markForwarded(req.params.name, username(req)));
  } catch (err) {
    fail(res, err, 409);
  }
});

router.put("/salespeople/:name", (req: Request, res: Response) => {
  try {
    const { phone } = req.body as { phone?: unknown };
    setSalespersonPhone(req.params.name, typeof phone === "string" ? phone : null);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 400);
  }
});

router.get("/log", (_req: Request, res: Response) => {
  try {
    res.json({ log: getLog() });
  } catch (err) {
    fail(res, err);
  }
});

router.post("/log/:id/undo", (req: Request, res: Response) => {
  try {
    undo(Number(req.params.id));
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 409);
  }
});

export default router;
