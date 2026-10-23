import { randomBytes, randomInt, createHash, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${scryptSync(pw, salt, 64).toString("base64")}`;
}

export function checkPassword(pw, stored) {
  const [, s, h] = stored.split("$");
  const a = scryptSync(pw, Buffer.from(s, "base64"), 64);
  const b = Buffer.from(h, "base64");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A hash to compare against when the username does not exist, so timing does not reveal it. */
export const DUMMY_HASH = hashPassword(randomBytes(8).toString("hex"));

export const newToken = () => randomBytes(32).toString("base64url");
export const sha256 = (t) => createHash("sha256").update(t).digest("hex");

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function tempPassword(len = 10) {
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Failed-login throttle: 5 misses locks that user+address for a minute. */
export function makeThrottle({ max = 5, lockMs = 60_000 } = {}) {
  const m = new Map();
  return {
    check(key) {
      const e = m.get(key);
      return !(e && e.until > Date.now());
    },
    fail(key) {
      const e = m.get(key) || { n: 0, until: 0 };
      e.n += 1;
      if (e.n >= max) { e.until = Date.now() + lockMs; e.n = 0; }
      m.set(key, e);
      if (m.size > 5000) m.clear();
    },
    ok(key) { m.delete(key); },
  };
}
