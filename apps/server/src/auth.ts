import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import type { Role } from "./documents.js";

export interface User {
  userId: string;
  name: string;
}

interface UserToken extends User {
  t: "user";
}
interface ShareToken {
  t: "share";
  docId: string;
  role: Exclude<Role, "owner">;
}

/** Sign a JSON payload as `base64url(body).base64url(hmac)`. Stateless. */
function sign(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verify<T>(token: string, secret: string): T | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString()) as T;
  } catch {
    return null;
  }
}

/** Mint a fresh guest identity and a token that proves it. */
export function issueGuest(name: string, secret: string): { token: string; user: User } {
  const user: User = { userId: randomUUID(), name };
  return { token: sign({ ...user, t: "user" }, secret), user };
}

/** Verify a bearer token and return the user, or null. */
export function verifyUser(token: string, secret: string): User | null {
  const payload = verify<UserToken>(token, secret);
  if (!payload || payload.t !== "user" || !payload.userId) return null;
  return { userId: payload.userId, name: payload.name };
}

/** Create a share-link token granting `role` on `docId`. */
export function signShare(docId: string, role: Exclude<Role, "owner">, secret: string): string {
  return sign({ t: "share", docId, role } satisfies ShareToken, secret);
}

export function verifyShare(
  token: string,
  secret: string,
): { docId: string; role: Exclude<Role, "owner"> } | null {
  const payload = verify<ShareToken>(token, secret);
  if (!payload || payload.t !== "share" || !payload.docId) return null;
  if (payload.role !== "editor" && payload.role !== "viewer") return null;
  return { docId: payload.docId, role: payload.role };
}
