import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DeviceIdentityProof, PasskeyAssertionPayload } from "@herdr-pocket/protocol";

export const ANCHOR_COOKIE_NAME = "hp_anchor";
const PROOF_MAX_SKEW_MS = 5 * 60_000;
const CHALLENGE_TTL_MS = 120_000;

export function parseSpkiEcP256(spkiB64u: string): KeyObject | null {
  try {
    if (!spkiB64u || spkiB64u.length > 512) return null;
    const der = Buffer.from(spkiB64u, "base64url");
    if (der.length < 40 || der.length > 256) return null;
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ec") return null;
    if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    return key;
  } catch {
    return null;
  }
}

export function verifyEcdsaP256Signature(
  spkiB64u: string,
  message: string,
  sigB64u: string,
  encoding: "ieee-p1363" | "der" = "ieee-p1363",
): boolean {
  const key = parseSpkiEcP256(spkiB64u);
  if (!key) return false;
  try {
    const sig = Buffer.from(sigB64u, "base64url");
    if (sig.length < 32 || sig.length > 160) return false;
    return verify("sha256", Buffer.from(message, "utf8"), { key, dsaEncoding: encoding }, sig);
  } catch {
    return false;
  }
}

/**
 * Verifies a browser/app identity proof signed by its non-extractable ECDSA P-256 keypair
 * (`herdr-pocket-id-v1:<proofTimestamp>:<identityPubKey>`).
 */
export function verifyDeviceIdentityProof(
  raw: unknown,
  nowMs = Date.now(),
): { identityPubKey: string; fingerprintHash?: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Partial<DeviceIdentityProof>;
  if (
    typeof p.identityPubKey !== "string" ||
    typeof p.proofSignature !== "string" ||
    typeof p.proofTimestamp !== "number" ||
    !Number.isFinite(p.proofTimestamp)
  ) {
    return null;
  }
  if (Math.abs(nowMs - p.proofTimestamp) > PROOF_MAX_SKEW_MS) return null;
  const msg = `herdr-pocket-id-v1:${p.proofTimestamp}:${p.identityPubKey}`;
  if (!verifyEcdsaP256Signature(p.identityPubKey, msg, p.proofSignature, "ieee-p1363")) {
    return null;
  }
  const fp = typeof p.fingerprintHash === "string" && p.fingerprintHash.trim() ? p.fingerprintHash.trim().slice(0, 128) : undefined;
  return { identityPubKey: p.identityPubKey, ...(fp ? { fingerprintHash: fp } : {}) };
}

export function verifyReconfirmEcdsa(
  challenge: string,
  identityPubKey: string,
  signatureB64u: string,
): boolean {
  if (!challenge || !identityPubKey || !signatureB64u) return false;
  const msg = `herdr-pocket-reconfirm-v1:${challenge}:${identityPubKey}`;
  return verifyEcdsaP256Signature(identityPubKey, msg, signatureB64u, "ieee-p1363");
}

export function parseAnchorCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

export function signAnchorToken(deviceId: string, sign: (data: string) => string, nowSec = Math.floor(Date.now() / 1000)): string {
  const payload = `${deviceId}.${nowSec}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyAnchorToken(cookieVal: string | undefined, sign: (data: string) => string): string | null {
  if (!cookieVal) return null;
  const parts = cookieVal.split(".");
  if (parts.length !== 3) return null;
  const [deviceId, tsStr, mac] = parts;
  if (!deviceId || !/^[A-Za-z0-9_-]{6,32}$/.test(deviceId) || !/^\d+$/.test(tsStr ?? "") || !mac) return null;
  const expected = sign(`${deviceId}.${tsStr}`);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return deviceId;
}

export function formatAnchorCookieHeader(value: string, secure: boolean): string {
  return `${ANCHOR_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=34560000${secure ? "; Secure" : ""}`;
}

export class ChallengeStore {
  private entries = new Map<string, { expiresAt: number; rpId: string }>();

  issue(rpId: string, now = Date.now()): { challenge: string; expiresAt: number; rpId: string } {
    this.sweep(now);
    const challenge = randomBytes(32).toString("base64url");
    const expiresAt = now + CHALLENGE_TTL_MS;
    this.entries.set(challenge, { expiresAt, rpId });
    return { challenge, expiresAt, rpId };
  }

  consume(challenge: string, now = Date.now()): { rpId: string } | null {
    this.sweep(now);
    const hit = this.entries.get(challenge);
    if (!hit) return null;
    this.entries.delete(challenge);
    if (hit.expiresAt < now) return null;
    return { rpId: hit.rpId };
  }

  private sweep(now: number): void {
    for (const [k, v] of this.entries) {
      if (v.expiresAt < now) this.entries.delete(k);
    }
  }
}

export function verifyPasskeyRegistration(params: {
  challenge: string;
  rpId: string;
  credId: string;
  publicKeySpki: string;
  clientDataJSON: string;
}): { credId: string; publicKeySpki: string } | null {
  if (!params.credId || params.credId.length > 512) return null;
  if (!parseSpkiEcP256(params.publicKeySpki)) return null;
  try {
    const cdBuf = Buffer.from(params.clientDataJSON, "base64url");
    const cd = JSON.parse(cdBuf.toString("utf8")) as { type?: string; challenge?: string; origin?: string };
    if (cd.type !== "webauthn.create" || cd.challenge !== params.challenge || typeof cd.origin !== "string") {
      return null;
    }
    const originHost = new URL(cd.origin).hostname;
    if (originHost !== params.rpId && !originHost.endsWith(`.${params.rpId}`)) return null;
    return { credId: params.credId, publicKeySpki: params.publicKeySpki };
  } catch {
    return null;
  }
}

export function verifyPasskeyAssertion(params: {
  challenge: string;
  rpId: string;
  publicKeySpki: string;
  prevSignCount: number;
  assertion: PasskeyAssertionPayload;
}): { ok: true; nextSignCount: number } | { ok: false } {
  const { assertion } = params;
  const key = parseSpkiEcP256(params.publicKeySpki);
  if (!key) return { ok: false };
  try {
    const cdBuf = Buffer.from(assertion.clientDataJSON, "base64url");
    const cd = JSON.parse(cdBuf.toString("utf8")) as { type?: string; challenge?: string; origin?: string };
    if (cd.type !== "webauthn.get" || cd.challenge !== params.challenge || typeof cd.origin !== "string") {
      return { ok: false };
    }
    const originHost = new URL(cd.origin).hostname;
    if (originHost !== params.rpId && !originHost.endsWith(`.${params.rpId}`)) {
      return { ok: false };
    }
    const authData = Buffer.from(assertion.authenticatorData, "base64url");
    if (authData.length < 37) return { ok: false };
    const rpHash = createHash("sha256").update(params.rpId, "utf8").digest();
    if (!timingSafeEqual(authData.subarray(0, 32), rpHash)) return { ok: false };
    const flags = authData[32]!;
    if ((flags & 0x01) === 0) return { ok: false }; // UP bit must be set
    const signCount = authData.readUInt32BE(33);
    if (signCount > 0 && params.prevSignCount > 0 && signCount <= params.prevSignCount) {
      return { ok: false };
    }
    const clientHash = createHash("sha256").update(cdBuf).digest();
    const signedData = Buffer.concat([authData, clientHash]);
    const sigBuf = Buffer.from(assertion.signature, "base64url");
    const ok = verify("sha256", signedData, key, sigBuf);
    if (!ok) return { ok: false };
    return { ok: true, nextSignCount: signCount > 0 ? signCount : params.prevSignCount };
  } catch {
    return { ok: false };
  }
}
