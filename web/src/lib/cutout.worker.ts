/// <reference lib="webworker" />
// Runs ISNet-general (fp16 weights) on WebGPU inside a dedicated worker so the page never janks.
// Same model and preprocessing as the server, so device and server cutouts match.
// Messages in:  {type:"preload"} | {type:"cutout", id, bitmap}
// Messages out: {type:"progress", loaded, total} | {type:"ready"} | {type:"result", id, png, bitmap, ms}
//               {type:"error", id?, message}
import * as ort from "onnxruntime-web/webgpu";
import { foregroundEstimate } from "./foreground";

declare const self: DedicatedWorkerGlobalScope;

const MODEL_URL =
  process.env.NEXT_PUBLIC_MODEL_URL ||
  `${(process.env.NEXT_PUBLIC_API_URL || "https://api.nobg.here").replace(/\/$/, "")}/models/isnet-fp16-281bde9e.bin`;
const MODEL_BYTES = 90_447_799;
const CACHE = "nobg-models-v2";
const SIZE = 1024;
const MAX_PIXELS = 16_000_000;

ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
ort.env.logLevel = "error";

let session: Promise<ort.InferenceSession> | null = null;

async function fetchModel(): Promise<ArrayBuffer> {
  const cache = await caches.open(CACHE).catch(() => null);
  const hit = await cache?.match(MODEL_URL);
  if (hit) {
    const buf = await hit.arrayBuffer();
    self.postMessage({ type: "progress", loaded: buf.byteLength, total: buf.byteLength, cached: true });
    return buf;
  }
  const res = await fetch(MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status})`);
  const total = Number(res.headers.get("content-length")) || MODEL_BYTES;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const now = performance.now();
    if (now - last > 80) {
      last = now;
      self.postMessage({ type: "progress", loaded, total });
    }
  }
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  self.postMessage({ type: "progress", loaded, total: loaded });
  cache?.put(MODEL_URL, new Response(buf.slice().buffer, { headers: { "content-type": "application/octet-stream" } })).catch(() => {});
  return buf.buffer;
}

function getSession() {
  if (!session) {
    session = (async () => {
      const model = await fetchModel();
      const s = await ort.InferenceSession.create(model, {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
      });
      // Warm-up compiles the WebGPU shaders so the first real image is fast.
      const warm = new ort.Tensor("float32", new Float32Array(3 * SIZE * SIZE), [1, 3, SIZE, SIZE]);
      const out = await s.run({ [s.inputNames[0]]: warm });
      Object.values(out).forEach((t) => t.dispose?.());
      self.postMessage({ type: "ready" });
      return s;
    })();
    session.catch(() => {
      session = null;
    });
  }
  return session;
}

function fit(w: number, h: number) {
  if (w * h <= MAX_PIXELS) return [w, h];
  const s = Math.sqrt(MAX_PIXELS / (w * h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

async function cutout(src: ImageBitmap) {
  const t0 = performance.now();
  const s = await getSession();
  const t1 = performance.now();
  const [W, H] = fit(src.width, src.height);

  // Full-res source pixels.
  const full = new OffscreenCanvas(W, H);
  const fctx = full.getContext("2d", { willReadFrequently: true })!;
  fctx.drawImage(src, 0, 0, W, H);
  const img = fctx.getImageData(0, 0, W, H);

  // Model input: 1024x1024 CHW, ISNet normalisation (x / max - 0.5).
  const small = new OffscreenCanvas(SIZE, SIZE);
  const sctx = small.getContext("2d", { willReadFrequently: true })!;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(src, 0, 0, SIZE, SIZE);
  const px = sctx.getImageData(0, 0, SIZE, SIZE).data;
  const n = SIZE * SIZE;
  let max = 1;
  for (let i = 0; i < n * 4; i++) if ((i & 3) !== 3 && px[i] > max) max = px[i];
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    input[i] = px[i * 4] / max - 0.5;
    input[n + i] = px[i * 4 + 1] / max - 0.5;
    input[2 * n + i] = px[i * 4 + 2] / max - 0.5;
  }
  const feeds = { [s.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, SIZE, SIZE]) };
  const out = await s.run(feeds);
  const logits = out[s.outputNames[0]];
  const data = (await logits.getData()) as Float32Array;
  Object.values(out).forEach((t) => t.dispose?.());

  // Min-max normalise -> 8-bit mask, then bilinear upscale to full res via canvas.
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (data[i] < lo) lo = data[i];
    if (data[i] > hi) hi = data[i];
  }
  const span = Math.max(hi - lo, 1e-6);
  const mask = new ImageData(SIZE, SIZE);
  for (let i = 0; i < n; i++) {
    const a = ((data[i] - lo) / span) * 255;
    const j = i * 4;
    mask.data[j] = mask.data[j + 1] = mask.data[j + 2] = a;
    mask.data[j + 3] = 255;
  }
  sctx.putImageData(mask, 0, 0);
  const t2 = performance.now();
  const up = new OffscreenCanvas(W, H);
  const uctx = up.getContext("2d", { willReadFrequently: true })!;
  uctx.imageSmoothingQuality = "high";
  uctx.drawImage(small, 0, 0, W, H);
  const alpha = uctx.getImageData(0, 0, W, H).data;

  // Strip background colour spill from soft edges, then write alpha.
  const rgba = foregroundEstimate(img, alpha, W, H);
  fctx.putImageData(rgba, 0, 0);
  const png = await full.convertToBlob({ type: "image/png" });
  const bitmap = full.transferToImageBitmap();
  return { png, bitmap, ms: Math.round(performance.now() - t1), inferMs: Math.round(t2 - t1), waitMs: Math.round(t1 - t0) };
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "preload") {
    getSession().catch((err) => self.postMessage({ type: "error", message: String(err?.message || err) }));
  } else if (msg.type === "cutout") {
    try {
      const r = await cutout(msg.bitmap);
      msg.bitmap.close();
      self.postMessage({ type: "result", id: msg.id, ...r }, [r.bitmap]);
    } catch (err) {
      self.postMessage({ type: "error", id: msg.id, message: String((err as Error)?.message || err) });
    }
  }
};
