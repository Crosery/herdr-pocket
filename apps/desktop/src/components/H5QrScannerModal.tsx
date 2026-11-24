import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { AlertCircle, Camera, ImageUp, QrCode, RefreshCw } from "lucide-react";
import { extractScannedPair, type ScannedPairPayload } from "../lib/h5Identity";
import { PocketBadge, PocketButton, PocketModal } from "./PocketUI";

export { extractScannedPair, type ScannedPairPayload };

interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue?: string }>>;
}

type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

async function loadJsQr(): Promise<
  (data: Uint8ClampedArray, width: number, height: number, options?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" }) => { data: string } | null
> {
  const mod = await import("jsqr");
  const fn = (mod as { default?: unknown }).default ?? mod;
  return fn as (
    data: Uint8ClampedArray,
    width: number,
    height: number,
    options?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" },
  ) => { data: string } | null;
}

function drawOnWhiteCanvas(
  canvas: HTMLCanvasElement,
  source: CanvasImageSource,
  srcWidth: number,
  srcHeight: number,
  maxSide: number,
  padPx = 0,
): ImageData | null {
  const scale = Math.min(1, maxSide / Math.max(1, srcWidth, srcHeight));
  const drawW = Math.max(1, Math.round(srcWidth * scale));
  const drawH = Math.max(1, Math.round(srcHeight * scale));
  canvas.width = drawW + padPx * 2;
  canvas.height = drawH + padPx * 2;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  // White fill keeps transparent-background QR PNGs decodable instead of blacking out quiet zones.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, padPx, padPx, drawW, drawH);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export async function decodeQrImageFile(file: File): Promise<string | null> {
  const Detector = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  const jsQR = await loadJsQr();
  const canvas = document.createElement("canvas");

  let bitmap: ImageBitmap | null = null;
  let objectUrl: string | null = null;
  try {
    if (typeof createImageBitmap === "function") {
      try {
        bitmap = await createImageBitmap(file);
      } catch {
        bitmap = null;
      }
    }

    if (bitmap) {
      if (Detector) {
        try {
          const hits = await new Detector({ formats: ["qr_code"] }).detect(bitmap);
          const raw = hits.find((h) => h.rawValue)?.rawValue?.trim();
          if (raw) return raw;
        } catch {
          // fall through to jsQR
        }
      }
      for (const [maxSide, pad] of [
        [1400, 24],
        [900, 32],
        [2000, 16],
      ] as const) {
        const imgData = drawOnWhiteCanvas(canvas, bitmap, bitmap.width, bitmap.height, maxSide, pad);
        if (!imgData) continue;
        const decoded = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: "attemptBoth" });
        if (decoded?.data) return decoded.data.trim();
      }
      return null;
    }

    objectUrl = URL.createObjectURL(file);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("图片无法加载，请换一张二维码图片或截图"));
      el.src = objectUrl!;
    });
    for (const [maxSide, pad] of [
      [1400, 24],
      [900, 32],
    ] as const) {
      const imgData = drawOnWhiteCanvas(canvas, img, img.naturalWidth || img.width, img.naturalHeight || img.height, maxSide, pad);
      if (!imgData) continue;
      const decoded = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: "attemptBoth" });
      if (decoded?.data) return decoded.data.trim();
    }
    return null;
  } finally {
    bitmap?.close?.();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

function describeCameraError(err: unknown): string {
  const name = (err as { name?: string } | null)?.name ?? "";
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "当前页面不是 HTTPS 安全上下文，浏览器限制调用摄像头；你可以点击下方“从相册 / 截图选二维码”。";
  }
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "未获得摄像头权限：请在浏览器地址栏允许访问相机，或直接点击下方“从相册 / 截图选二维码”。";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "当前设备未检测到可用摄像头，可直接点击下方“从相册 / 截图选二维码”。";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "摄像头正被其他应用占用，可关闭占用后重试，或点击“从相册 / 截图选二维码”。";
  }
  return "无法开启摄像头，可点击“重试摄像头”或改用“从相册 / 截图选二维码”。";
}

/** Phone-like H5 QR scanner supporting live camera streaming and gallery/screenshot decoding. */
export function H5QrScannerModal({
  open,
  onOpenChange,
  onScanned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onScanned: (parsed: ScannedPairPayload, rawText: string) => void | Promise<void>;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const handledRef = useRef(false);
  const mountedRef = useRef(true);
  const onScannedRef = useRef(onScanned);
  onScannedRef.current = onScanned;

  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [cameraState, setCameraState] = useState<"starting" | "live" | "error" | "connecting">("starting");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const stopCamera = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const acceptQrText = useCallback(
    async (raw: string) => {
      if (handledRef.current) return;
      const parsed = extractScannedPair(raw, typeof window !== "undefined" ? window.location.href : undefined);
      if (!parsed) {
        if (mountedRef.current) {
          setNotice("识别到的二维码不是 Herdr Pocket 配对码，请扫描桌面端或命令行显示的配对码。");
        }
        return;
      }
      handledRef.current = true;
      stopCamera();
      if (mountedRef.current) {
        setCameraState("connecting");
        setError(null);
        setNotice(`已识别配对码 ${parsed.code}，正在连接…`);
      }
      try {
        await onScannedRef.current(parsed, raw);
      } catch (err) {
        handledRef.current = false;
        if (mountedRef.current) {
          setCameraState("error");
          setNotice(null);
          setError((err as Error)?.message || "配对连接失败，请重新扫码");
        }
      }
    },
    [stopCamera],
  );

  useEffect(() => {
    if (!open) {
      stopCamera();
      handledRef.current = false;
      setError(null);
      setNotice(null);
      setCameraState("starting");
      return;
    }

    let cancelled = false;
    let scanTimer: number | null = null;
    let busyFrame = false;
    handledRef.current = false;
    setError(null);
    setNotice(null);
    setCameraState("starting");

    const DetectorCtor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
    let detector: BarcodeDetectorLike | null = null;
    if (DetectorCtor) {
      try {
        detector = new DetectorCtor({ formats: ["qr_code"] });
      } catch {
        detector = null;
      }
    }
    const jsQrPromise = loadJsQr();

    const scanFrame = async () => {
      if (cancelled || handledRef.current || busyFrame) return;
      const video = videoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return;
      busyFrame = true;
      try {
        if (detector) {
          try {
            const hits = await detector.detect(video);
            const raw = hits.find((h) => h.rawValue)?.rawValue?.trim();
            if (raw && !cancelled) {
              await acceptQrText(raw);
              return;
            }
          } catch {
            // ignore detector failure on unsupported formats/surfaces and fall back to jsQR
          }
        }

        const jsQR = await jsQrPromise;
        if (cancelled || handledRef.current) return;
        const canvas = (canvasRef.current ??= document.createElement("canvas"));
        const imgData = drawOnWhiteCanvas(canvas, video, video.videoWidth, video.videoHeight, 900, 0);
        if (!imgData) return;
        const hit = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: "attemptBoth" });
        if (hit?.data && !cancelled) {
          await acceptQrText(hit.data.trim());
        }
      } finally {
        busyFrame = false;
      }
    };

    const start = async () => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
        if (!cancelled) {
          setCameraState("error");
          setError(describeCameraError(new Error("DevicesNotFoundError")));
        }
        return;
      }
      try {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        if (cancelled) {
          for (const t of stream.getTracks()) t.stop();
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
        }
        if (!cancelled) {
          setCameraState("live");
          scanTimer = window.setInterval(() => void scanFrame(), 180);
        }
      } catch (err) {
        if (!cancelled) {
          setCameraState("error");
          setError(describeCameraError(err));
        }
      }
    };

    void start();

    return () => {
      cancelled = true;
      if (scanTimer !== null) window.clearInterval(scanTimer);
      stopCamera();
    };
  }, [acceptQrText, facingMode, open, retryNonce, stopCamera]);

  const onPickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(null);
    setNotice("正在识别图片中的二维码…");
    try {
      const raw = await decodeQrImageFile(file);
      if (!raw) {
        setNotice(null);
        setError("图片里未识别到清晰的二维码，请换一张清晰截图或完整二维码图片。");
        return;
      }
      await acceptQrText(raw);
    } catch (err) {
      setNotice(null);
      setError((err as Error)?.message || "图片二维码解析失败");
    }
  };

  return (
    <PocketModal
      open={open}
      onOpenChange={(next) => {
        if (!next) stopCamera();
        onOpenChange(next);
      }}
      title="摄像头扫码连接"
      subtitle="对准桌面端“扫码连接手机”、CLI 终端或已登录设备上的配对二维码"
      width={460}
    >
      <div className="stack" style={{ gap: 12 }}>
        {error ? (
          <div className="inline-alert" role="alert">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="h5-qr-stage">
          <video
            ref={videoRef}
            className="h5-qr-video"
            playsInline
            muted
            autoPlay
            aria-label="扫码取景框"
          />
          {cameraState === "live" ? (
            <div className="h5-qr-reticle" aria-hidden="true">
              <span className="h5-qr-corner tl" />
              <span className="h5-qr-corner tr" />
              <span className="h5-qr-corner bl" />
              <span className="h5-qr-corner br" />
            </div>
          ) : null}
          {cameraState !== "live" ? (
            <div className="h5-qr-overlay">
              <QrCode size={28} />
              <div className="h5-qr-overlay-text">
                {cameraState === "starting"
                  ? "正在开启摄像头…"
                  : cameraState === "connecting"
                    ? "二维码已识别，正在配对连接…"
                    : "摄像头未就绪，也可直接导入二维码截图"}
              </div>
            </div>
          ) : null}
        </div>

        {notice ? (
          <div className="row wrap" style={{ gap: 8, alignItems: "center" }}>
            <PocketBadge tone="pink">{notice}</PocketBadge>
          </div>
        ) : null}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          aria-label="从相册或截图选择二维码图片"
          onChange={(e) => void onPickFile(e)}
        />

        <div className="row wrap" style={{ justifyContent: "space-between", gap: 8 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <PocketButton
              variant="soft"
              size="sm"
              disabled={cameraState === "connecting"}
              onClick={() => fileInputRef.current?.click()}
            >
              <ImageUp size={14} />
              <span>从相册 / 截图选二维码</span>
            </PocketButton>
            {cameraState === "error" ? (
              <PocketButton
                variant="ghost"
                size="sm"
                onClick={() => {
                  setError(null);
                  setRetryNonce((n) => n + 1);
                }}
              >
                <RefreshCw size={14} />
                <span>重试摄像头</span>
              </PocketButton>
            ) : (
              <PocketButton
                variant="ghost"
                size="sm"
                disabled={cameraState === "connecting"}
                onClick={() => setFacingMode((m) => (m === "environment" ? "user" : "environment"))}
              >
                <Camera size={14} />
                <span>{facingMode === "environment" ? "切到前置镜头" : "切到后置镜头"}</span>
              </PocketButton>
            )}
          </div>
          <PocketButton variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            关闭
          </PocketButton>
        </div>
      </div>
    </PocketModal>
  );
}
