import { DIRECT_PUT_PREFIX } from "@herdr-pocket/protocol";
import { logger } from "./log";
import { ensureDirectLinkNow, getDirectEndpoint, rpcCall } from "./relay";

function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function postRawDirectPut(
  url: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<boolean> {
  if (typeof XMLHttpRequest === "undefined") {
    return fetch(url, { method: "POST", body: file })
      .then((r) => r.ok)
      .catch(() => false);
  }
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.timeout = 0;
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        onProgress?.(Math.min(99, Math.round((ev.loaded / ev.total) * 100)));
      }
    };
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.onabort = () => resolve(false);
    xhr.send(file);
  });
}

async function waitDirectEndpoint(deviceId: string, waitMs: number): Promise<{ addr: string; port: number } | null> {
  const immediate = getDirectEndpoint(deviceId);
  if (immediate) return immediate;
  ensureDirectLinkNow(deviceId);
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 80));
    const hit = getDirectEndpoint(deviceId);
    if (hit) return hit;
  }
  return null;
}

/**
 * Uploads a large non-image file (`> 5 MB`) onto a remote computer using direct P2P HTTP
 * (`POST /v1/direct-put/<token>` via native TCP tunnel when available) or sequential
 * 2 MB `terminal.putChunk` RPC slices over the relay, without materializing the full file
 * in JS memory.
 */
export async function uploadRemoteFile(
  deviceId: string,
  agentKey: string,
  file: File,
  onProgress?: (pct: number, viaDirect: boolean) => void,
): Promise<string> {
  const startedAt = Date.now();
  logger.info("files", "files.upload.start", {
    bytes: file.size,
    mime: file.type || "application/octet-stream",
  });
  const begin = await rpcCall(
    deviceId,
    "terminal.putBegin",
    {
      agent: agentKey,
      name: file.name || "file",
      mime: file.type || "application/octet-stream",
      totalBytes: file.size,
    },
    30_000,
  );

  let uploadedDirect = false;
  try {
    if (begin.directToken) {
      const ep = await waitDirectEndpoint(deviceId, 450);
      if (ep) {
        const host = ep.addr.includes(":") ? `[${ep.addr}]` : ep.addr;
        const url = `http://${host}:${ep.port}${DIRECT_PUT_PREFIX}/${encodeURIComponent(begin.directToken)}`;
        onProgress?.(0, true);
        uploadedDirect = await postRawDirectPut(url, file, (pct) => onProgress?.(pct, true));
      }
    }

    if (!uploadedDirect) {
      const chunkBytes = Math.max(256 * 1024, begin.chunkBytes || 2 * 1024 * 1024);
      const total = Math.max(1, file.size);
      for (let offset = 0, index = 0; offset < file.size; offset += chunkBytes, index += 1) {
        const slice = file.slice(offset, Math.min(file.size, offset + chunkBytes));
        const buf = new Uint8Array(await slice.arrayBuffer());
        await rpcCall(
          deviceId,
          "terminal.putChunk",
          {
            uploadId: begin.uploadId,
            index,
            data: bytesToBase64(buf),
          },
          60_000,
        );
        onProgress?.(Math.min(99, Math.round((Math.min(file.size, offset + buf.byteLength) / total) * 100)), false);
      }
    }

    const fin = await rpcCall(deviceId, "terminal.putFinish", { uploadId: begin.uploadId }, 60_000);
    onProgress?.(100, uploadedDirect);
    logger.info("files", "files.upload.done", {
      viaDirect: uploadedDirect,
      bytes: file.size,
      ms: Date.now() - startedAt,
    });
    return fin.path;
  } catch (err) {
    logger.error("files", `files.upload.error: ${(err as Error)?.message ?? String(err)}`, {
      viaDirect: uploadedDirect,
      bytes: file.size,
      ms: Date.now() - startedAt,
    });
    void rpcCall(deviceId, "terminal.putAbort", { uploadId: begin.uploadId }).catch(() => {});
    throw err;
  }
}
