import { Router, Request, Response } from "express";
import { getEnv } from "../env";
import { verifyWebhookSignature } from "../services/whatsappClient";

const router = Router();

// Meta calls this once, when you register the webhook URL in Meta Business
// Manager, to prove you control the endpoint — echo back hub.challenge if
// hub.verify_token matches the value you configured there.
router.get("/", (req: Request, res: Response) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === getEnv("WHATSAPP_VERIFY_TOKEN")) {
    console.log("[whatsappWebhook] verification handshake succeeded");
    res.status(200).send(challenge);
    return;
  }

  console.warn("[whatsappWebhook] verification handshake failed — token mismatch");
  res.status(403).end();
});

router.post("/", (req: Request, res: Response) => {
  const rawBody = (req as any).rawBody as Buffer | undefined;
  const signature = req.headers["x-hub-signature-256"] as string | undefined;

  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn("[whatsappWebhook] signature verification failed — rejecting");
    res.status(401).end();
    return;
  }

  // Ack immediately — Meta retries aggressively (and eventually disables the
  // webhook) if it doesn't get a fast 200.
  res.status(200).end();

  console.log("[whatsappWebhook] raw payload:", JSON.stringify(req.body));

  // TODO: once a specific use case is wired up (e.g. inbound replies to a tagihan
  // reminder), parse req.body.entry[].changes[].value.messages[] here. For now this
  // just logs so real payload shapes can be confirmed against Meta's docs.
});

export default router;
