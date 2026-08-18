import crypto from "crypto";
import { db } from "../db";

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function encodePassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${hashPassword(password, salt)}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = hashPassword(password, salt);
  const candidateBuf = Buffer.from(candidate, "hex");
  const hashBuf = Buffer.from(hash, "hex");
  return candidateBuf.length === hashBuf.length && crypto.timingSafeEqual(candidateBuf, hashBuf);
}

export function createUser(username: string, password: string): void {
  db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)").run(
    username,
    encodePassword(password),
    new Date().toISOString()
  );
}

export function findUserByUsername(username: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
}

export function findUserById(id: number): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function listUsers(): { id: number; username: string; created_at: string }[] {
  return db.prepare("SELECT id, username, created_at FROM users ORDER BY id").all() as {
    id: number;
    username: string;
    created_at: string;
  }[];
}

export function verifyLogin(username: string, password: string): UserRow | undefined {
  const user = findUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return undefined;
  }
  return user;
}

// Seeds the first user only if the table is empty — safe to call on every
// startup, never overwrites an existing account (including if the password
// was since changed).
export function seedInitialUserIfNeeded(username: string, password: string): void {
  const count = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
  if (count.c === 0) {
    createUser(username, password);
    console.log(`[auth] seeded initial user "${username}"`);
  }
}
