import { Router, Request, Response } from "express";
import { verifyLogin, createUser, listUsers, findUserByUsername } from "../services/auth";
import { requireAuth } from "../middleware/requireAuth";
import "../types/session";

const router = Router();

router.post("/login", (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  const user = verifyLogin(username, password);
  if (!user) {
    return res.status(401).json({ error: "Invalid username or password" });
  }

  req.session.userId = user.id;
  res.json({ username: user.username });
});

router.post("/logout", (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

router.get("/me", (req: Request, res: Response) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not logged in" });
  }
  res.json({ userId: req.session.userId });
});

// Adding a user requires already being logged in — there's no separate admin
// role yet, any logged-in user can add another.
router.get("/users", requireAuth, (_req: Request, res: Response) => {
  res.json(listUsers());
});

router.post("/users", requireAuth, (req: Request, res: Response) => {
  const { username, password } = req.body ?? {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters" });
  }
  if (findUserByUsername(username)) {
    return res.status(409).json({ error: "That username is already taken" });
  }

  createUser(username, password);
  res.status(201).json({ username });
});

export default router;
