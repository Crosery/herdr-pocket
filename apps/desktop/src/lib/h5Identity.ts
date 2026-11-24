import type {
  Device,
  DeviceIdentityProof,
  IdentityChallengeResponse,
  IdentityHintResponse,
  PairResponse,
} from "@herdr-pocket/protocol";

export interface RecognizedWebDevice {
  name: string;
  platform: "h5-ios" | "h5-ipados" | "h5-android" | "h5-harmony" | "h5-macos" | "h5-windows" | "h5-linux" | "h5-web";
  formFactor: "mobile" | "tablet" | "desktop";
  osLabel: string;
  browserLabel: string;
}

const SESSION_KEY = "herdr-pocket-client-session-v1";
const IDB_NAME = "herdr-pocket-idb-v1";
const IDB_STORE = "kv";
const IDB_KEY_RECORD = "identity-ecdsa-p256";
const IDB_SESSION_RECORD = "vault-session";
const CACHE_NAME = "herdr-pocket-vault-v1";
const CACHE_URL = "./_pocket_vault_session.json";

interface StoredKeyRecord {
  publicKeySpki: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
}

function bytesToB64Url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64UrlToBytes(b64u: string): Uint8Array {
  const pad = b64u.length % 4 === 0 ? "" : "=".repeat(4 - (b64u.length % 4));
  const b64 = b64u.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Infers Relay base URL cleanly even behind reverse-proxy subpaths (`/pocket/app/` -> `https://.../pocket`). */
export function inferRelayUrlFromLocation(loc?: Pick<Location, "origin" | "pathname"> | null): string {
  if (!loc || !loc.origin || loc.origin === "null" || !/^https?:/i.test(loc.origin)) return "";
  const prefix = (loc.pathname || "")
    .replace(/\/(?:app|h5)(?:\/.*)?$/i, "")
    .replace(/\/+$/, "");
  return `${loc.origin}${prefix}`;
}

/** Recognizes the browser's true OS, form factor (catching iPadOS desktop UA), and browser brand. */
export function recognizeWebDevice(
  nav?: { userAgent?: string; platform?: string; maxTouchPoints?: number },
  win?: { innerWidth?: number; screen?: { width?: number; height?: number } },
): RecognizedWebDevice {
  const n = nav ?? (typeof navigator !== "undefined" ? navigator : {});
  const w = win ?? (typeof window !== "undefined" ? window : undefined);
  const ua = n.userAgent ?? "";
  const plat = n.platform ?? "";
  const touch = n.maxTouchPoints ?? 0;

  const isHarmony = /harmonyos|openharmony|arkweb|hms/i.test(ua);
  const isIPhone = /iphone|ipod/i.test(ua);
  const isIpad = /ipad/i.test(ua) || (/macintosh|macintel/i.test(`${plat} ${ua}`) && touch > 1);
  const isAndroid = /android/i.test(ua);
  const isAndroidTablet = isAndroid && !/mobile/i.test(ua);
  const isMac = !isIpad && !isIPhone && /mac/i.test(`${plat} ${ua}`);
  const isWin = /win/i.test(`${plat} ${ua}`);
  const isLinux = !isAndroid && /linux/i.test(`${plat} ${ua}`);

  let browserLabel = "浏览器";
  if (/micromessenger/i.test(ua)) browserLabel = "微信";
  else if (/lark|feishu/i.test(ua)) browserLabel = "飞书";
  else if (/edg(?:e|a|ios)?\//i.test(ua)) browserLabel = "Edge";
  else if (/firefox|fxios/i.test(ua)) browserLabel = "Firefox";
  else if (/crios|chrome\//i.test(ua) && !/opr\//i.test(ua)) browserLabel = "Chrome";
  else if (/safari/i.test(ua)) browserLabel = "Safari";

  let osLabel = "浏览器";
  let platform: RecognizedWebDevice["platform"] = "h5-web";
  let formFactor: RecognizedWebDevice["formFactor"] = "desktop";

  if (isHarmony) {
    osLabel = "HarmonyOS";
    platform = "h5-harmony";
    const sw = Math.min(w?.screen?.width ?? w?.innerWidth ?? 400, w?.screen?.height ?? 900);
    formFactor = sw >= 680 ? "tablet" : "mobile";
  } else if (isIPhone) {
    osLabel = "iPhone";
    platform = "h5-ios";
    formFactor = "mobile";
  } else if (isIpad) {
    osLabel = "iPad";
    platform = "h5-ipados";
    formFactor = "tablet";
  } else if (isAndroid) {
    osLabel = "Android";
    platform = "h5-android";
    formFactor = isAndroidTablet ? "tablet" : "mobile";
  } else if (isMac) {
    osLabel = "Mac";
    platform = "h5-macos";
    formFactor = "desktop";
  } else if (isWin) {
    osLabel = "Windows";
    platform = "h5-windows";
    formFactor = "desktop";
  } else if (isLinux) {
    osLabel = "Linux";
    platform = "h5-linux";
    formFactor = "desktop";
  } else {
    const minDim = Math.min(w?.innerWidth ?? 1000, w?.screen?.width ?? 1000);
    formFactor = minDim < 860 ? "mobile" : "desktop";
  }

  return {
    name: `${osLabel} · ${browserLabel} (H5)`,
    platform,
    formFactor,
    osLabel,
    browserLabel,
  };
}

function openIdentityDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openIdentityDb();
  if (!db) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    db.close();
  }
}

async function idbPut(key: string, val: unknown): Promise<void> {
  const db = await openIdentityDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore storage quota / private mode failures
  } finally {
    db.close();
  }
}

async function idbDelete(key: string): Promise<void> {
  const db = await openIdentityDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // ignore
  } finally {
    db.close();
  }
}

export async function readVaultSession<T>(): Promise<T | null> {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    // ignore
  }
  const fromIdb = await idbGet<T>(IDB_SESSION_RECORD);
  if (fromIdb) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(fromIdb));
    } catch {
      // ignore
    }
    return fromIdb;
  }
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(CACHE_URL);
      if (hit) {
        const parsed = (await hit.json()) as T;
        if (parsed) {
          try {
            localStorage.setItem(SESSION_KEY, JSON.stringify(parsed));
          } catch {
            // ignore
          }
          await idbPut(IDB_SESSION_RECORD, parsed);
          return parsed;
        }
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export async function writeVaultSession<T>(session: T): Promise<void> {
  const json = JSON.stringify(session);
  try {
    localStorage.setItem(SESSION_KEY, json);
  } catch {
    // ignore
  }
  await idbPut(IDB_SESSION_RECORD, session);
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(
        CACHE_URL,
        new Response(json, { headers: { "content-type": "application/json" } }),
      );
    } catch {
      // ignore
    }
  }
}

export async function clearVaultSession(): Promise<void> {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
  await idbDelete(IDB_SESSION_RECORD);
  if (typeof caches !== "undefined") {
    try {
      await caches.delete(CACHE_NAME);
    } catch {
      // ignore
    }
  }
}

async function computeTraitFingerprint(): Promise<string | undefined> {
  if (typeof crypto === "undefined" || !crypto.subtle || typeof navigator === "undefined") return undefined;
  try {
    const traits = [
      navigator.platform || "",
      String(navigator.hardwareConcurrency || ""),
      String(navigator.maxTouchPoints || 0),
      Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      navigator.language || "",
      typeof window !== "undefined" ? `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}@${window.devicePixelRatio || 1}` : "",
    ].join("|");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(traits));
    return bytesToB64Url(digest);
  } catch {
    return undefined;
  }
}

async function getOrCreateIdentityKeyPair(): Promise<StoredKeyRecord | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  const cached = await idbGet<StoredKeyRecord>(IDB_KEY_RECORD);
  if (cached?.publicKeySpki && cached.privateKey) return cached;
  try {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
    const rec: StoredKeyRecord = {
      publicKeySpki: bytesToB64Url(spki),
      privateKey: kp.privateKey,
      publicKey: kp.publicKey,
    };
    await idbPut(IDB_KEY_RECORD, rec);
    return rec;
  } catch {
    return null;
  }
}

export async function createIdentityProof(): Promise<DeviceIdentityProof | undefined> {
  const rec = await getOrCreateIdentityKeyPair();
  if (!rec) return undefined;
  try {
    const ts = Date.now();
    const msg = `herdr-pocket-id-v1:${ts}:${rec.publicKeySpki}`;
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      rec.privateKey,
      new TextEncoder().encode(msg),
    );
    const fp = await computeTraitFingerprint();
    const dev = recognizeWebDevice();
    return {
      identityPubKey: rec.publicKeySpki,
      proofSignature: bytesToB64Url(sig),
      proofTimestamp: ts,
      ...(fp ? { fingerprintHash: fp } : {}),
      uaPlatform: dev.platform,
      formFactor: dev.formFactor,
    };
  } catch {
    return undefined;
  }
}

export async function fetchIdentityHint(relayUrl: string): Promise<IdentityHintResponse | null> {
  if (!relayUrl) return null;
  try {
    const res = await fetch(`${relayUrl.replace(/\/+$/, "")}/v1/identity/hint`, { credentials: "same-origin" });
    if (!res.ok) return null;
    return (await res.json()) as IdentityHintResponse;
  } catch {
    return null;
  }
}

export async function trySilentReconfirm(relayUrl: string): Promise<PairResponse | null> {
  if (!relayUrl || typeof crypto === "undefined" || !crypto.subtle) return null;
  const rec = await idbGet<StoredKeyRecord>(IDB_KEY_RECORD);
  if (!rec?.publicKeySpki || !rec.privateKey) return null;
  const base = relayUrl.replace(/\/+$/, "");
  try {
    const chRes = await fetch(`${base}/v1/identity/challenge`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!chRes.ok) return null;
    const ch = (await chRes.json()) as IdentityChallengeResponse;
    const msg = `herdr-pocket-reconfirm-v1:${ch.challenge}:${rec.publicKeySpki}`;
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      rec.privateKey,
      new TextEncoder().encode(msg),
    );
    const recognized = recognizeWebDevice();
    const verifyRes = await fetch(`${base}/v1/identity/reconfirm`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challenge: ch.challenge,
        identityPubKey: rec.publicKeySpki,
        signature: bytesToB64Url(sig),
        platform: recognized.platform,
      }),
    });
    if (!verifyRes.ok) return null;
    return (await verifyRes.json()) as PairResponse;
  } catch {
    return null;
  }
}

export function isPasskeySupported(): boolean {
  return typeof window !== "undefined" && typeof navigator !== "undefined" && Boolean(navigator.credentials && window.PublicKeyCredential);
}

export async function registerDevicePasskey(relayUrl: string, token: string): Promise<Device> {
  if (!isPasskeySupported()) {
    throw new Error("当前浏览器不支持硬件通行密钥 (WebAuthn)");
  }
  const base = relayUrl.replace(/\/+$/, "");
  const optRes = await fetch(`${base}/v1/identity/passkey/options`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: "{}",
  });
  if (!optRes.ok) throw new Error("获取通行密钥配置失败");
  const opt = (await optRes.json()) as {
    challenge: string;
    rp: { id: string; name: string };
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: PublicKeyCredentialParameters[];
  };

  const created = (await navigator.credentials.create({
    publicKey: {
      challenge: b64UrlToBytes(opt.challenge) as BufferSource,
      rp: opt.rp,
      user: {
        id: new TextEncoder().encode(opt.user.id),
        name: opt.user.name,
        displayName: opt.user.displayName,
      },
      pubKeyCredParams: opt.pubKeyCredParams,
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;

  if (!created) throw new Error("未完成通行密钥绑定");
  const resp = created.response as AuthenticatorAttestationResponse & { getPublicKey?: () => ArrayBuffer | null };
  const spki = resp.getPublicKey?.();
  if (!spki) throw new Error("浏览器未返回通行密钥公钥");

  const regRes = await fetch(`${base}/v1/identity/passkey/register`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      challenge: opt.challenge,
      credId: created.id,
      publicKeySpki: bytesToB64Url(spki),
      clientDataJSON: bytesToB64Url(resp.clientDataJSON),
    }),
  });
  const body = (await regRes.json().catch(() => ({}))) as { device?: Device; error?: { message?: string } };
  if (!regRes.ok || !body.device) throw new Error(body.error?.message || "通行密钥绑定失败");
  return body.device;
}

export async function reconfirmWithPasskey(relayUrl: string): Promise<PairResponse> {
  if (!isPasskeySupported()) {
    throw new Error("当前浏览器不支持通行密钥");
  }
  const base = relayUrl.replace(/\/+$/, "");
  const chRes = await fetch(`${base}/v1/identity/challenge`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!chRes.ok) throw new Error("获取身份验证挑战失败");
  const ch = (await chRes.json()) as IdentityChallengeResponse;

  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: b64UrlToBytes(ch.challenge) as BufferSource,
      rpId: ch.rpId,
      userVerification: "preferred",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new Error("未完成通行密钥验证");
  const resp = assertion.response as AuthenticatorAssertionResponse;
  const recognized = recognizeWebDevice();

  const res = await fetch(`${base}/v1/identity/reconfirm`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challenge: ch.challenge,
      platform: recognized.platform,
      passkey: {
        id: assertion.id,
        rawId: bytesToB64Url(assertion.rawId),
        authenticatorData: bytesToB64Url(resp.authenticatorData),
        clientDataJSON: bytesToB64Url(resp.clientDataJSON),
        signature: bytesToB64Url(resp.signature),
        ...(resp.userHandle ? { userHandle: bytesToB64Url(resp.userHandle) } : {}),
      },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as PairResponse & { error?: { message?: string } };
  if (!res.ok || !body.token) throw new Error(body.error?.message || "通行密钥验证未通过");
  return body;
}
