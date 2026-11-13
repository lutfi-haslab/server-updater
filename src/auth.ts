import { createHmac, randomBytes } from "node:crypto";
import type { SessionInfo } from "./types.ts";

export const ACTIVE_SESSIONS = new Map<string, SessionInfo>();

export interface AuthContext {
  adminUsername?: string;
  adminPassword?: string;
  uploadAuthKey?: string;
}

export function createSessionToken(username: string, secret: string): string {
  const nonce = randomBytes(16).toString("hex");
  const timestamp = Date.now();
  const payload = `${username}:${timestamp}:${nonce}`;
  const hmac = createHmac("sha256", secret || "metdesk-default-secret-salt")
    .update(payload)
    .digest("hex");
  const token = Buffer.from(`${payload}:${hmac}`).toString("base64url");

  // Keep in active sessions map for local / memory lookup
  ACTIVE_SESSIONS.set(token, { username, createdAt: timestamp });
  return token;
}

export function verifySessionToken(
  token: string,
  secret: string,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000
): { valid: boolean; username?: string } {
  // 1. In-memory session check
  if (ACTIVE_SESSIONS.has(token)) {
    const sess = ACTIVE_SESSIONS.get(token);
    return { valid: true, username: sess?.username || "admin" };
  }

  // 2. Stateless HMAC check
  try {
    const raw = Buffer.from(token, "base64url").toString("utf-8");
    const parts = raw.split(":");
    if (parts.length === 4) {
      const [username, timestampStr, nonce, receivedHmac] = parts;
      const timestamp = parseInt(timestampStr, 10);
      if (Date.now() - timestamp > maxAgeMs) {
        return { valid: false };
      }
      const expectedPayload = `${username}:${timestampStr}:${nonce}`;
      const expectedHmac = createHmac("sha256", secret || "metdesk-default-secret-salt")
        .update(expectedPayload)
        .digest("hex");
      if (expectedHmac === receivedHmac) {
        return { valid: true, username };
      }
    }
  } catch {}

  return { valid: false };
}

export function isRequestAuthenticated(req: Request, ctx: AuthContext): boolean {
  const adminPassword = (ctx.adminPassword || "").trim();
  const uploadAuthKey = (ctx.uploadAuthKey || "").trim();
  const adminUsername = (ctx.adminUsername || "admin").trim();

  // If no password and no API key configured, open access
  if (!adminPassword && !uploadAuthKey) {
    return true;
  }

  const apiKey = req.headers.get("X-API-Key");
  const authHeader = (req.headers.get("Authorization") || "").trim();
  const secret = adminPassword || uploadAuthKey || "metdesk-default-secret-salt";

  // 1. Check CI/CD token / API key
  if (uploadAuthKey) {
    if (apiKey && apiKey.trim() === uploadAuthKey) {
      return true;
    }
    if (authHeader.startsWith("Bearer ") && authHeader.slice(7).trim() === uploadAuthKey) {
      return true;
    }
  }

  // 2. Check Session Cookie (Web UI)
  const cookieHeader = req.headers.get("Cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith("session=")) {
      const token = trimmed.slice("session=".length).trim();
      const verified = verifySessionToken(token, secret);
      if (verified.valid) {
        return true;
      }
    }
  }

  // 3. Check Session Token via Bearer header
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    const verified = verifySessionToken(token, secret);
    if (verified.valid) {
      return true;
    }
  }

  // 4. Check HTTP Basic Auth (admin:password)
  if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6).trim(), "base64").toString("utf-8");
      if (decoded.includes(":")) {
        const [u, p] = decoded.split(":", 2);
        if (adminPassword && u === adminUsername && p === adminPassword) {
          return true;
        }
      }
    } catch {}
  }

  return false;
}
