import { Request, Response, NextFunction } from "express";
import "../types/session";

// API requests get a 401 JSON body (app.js redirects to /login.html on that);
// plain browser navigation gets redirected straight to the login page instead of
// a raw 401, since a signed-out user hitting "/" should just see the login form.
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.session.userId) {
    next();
    return;
  }

  if (req.headers.accept?.includes("text/html")) {
    res.redirect("/login.html");
    return;
  }

  res.status(401).json({ error: "Not logged in" });
}
