/// <reference lib="webworker" />
// Runs the cutout models on WebGPU inside a dedicated worker so the page never janks.
//   full:  ISNet-general (fp16 weights, 90 MB). Same model and preprocessing as the server,
//          so device and server cutouts match.
//   quick: MODNet portrait matting (fp16, 13 MB, CPU/wasm). Only used for a fast preview on
//          the first visit while ISNet is still downloading.
// Messages in:  {type:"preload", model} | {type:"cutout", id, model, bitmap}
// Messages out: {type:"progress", model, loaded, total, cached?} | {type:"ready", model}
//               {type:"result", id, png, bitmap, ms} | {type:"error", id?, model?, message}
import * as ort from "onnxruntime-web/webgpu";
import { foregroundEstimate } from "./foreground";
import { MODEL_CACHE as CACHE, MODELS, type Model } from "./models";

declare const self: DedicatedWorkerGlobalScope;

const ISNET_SIZE = 1024;
const MAX_PIXELS = 16_000_000;

ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
ort.env.logLevel = "error";

const sessions: Partial<Record<Model, Promise<ort.InferenceSession>>> = {};

async function fetchModel(model: Model): Promise<ArrayBuffer> {
  const { url, bytes } = MODELS[model];
  const cache = await caches.open(CACHE).catch(() => null);
  const hit = await cache?.match(url);
  if (hit) {
    const buf = await hit.arrayBuffer();
    self.postMessage({ type: "progress", model, loaded: buf.byteLength, total: buf.byteLength, cached: true });
    return buf;
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status})`);
  const total = Number(res.headers.get("content-length")) || bytes;
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
      self.postMessage({ type: "progress", model, loaded, total });
    }
  }
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  self.postMessage({ type: "progress", model, loaded, total: loaded });
  cache?.put(url, new Response(buf.slice().buffer, { headers: { "content-type": "application/octet-stream" } })).catch(() => {});
  return buf.buffer;
}

function getSession(model: Model) {
  let s = sessions[model];
  if (!s) {
    s = (async () => {
      // Don't let the 90 MB download compete for bandwidth with the quick preview model.
      if (model === "full" && sessions.quick) await sessions.quick.catch(() => {});
      const buf = await fetchModel(model);
      // MODNet runs on the CPU (wasm): ORT Web's WebGPU kernels give a wrong matte for it in both
      // fp16 and fp32 (checked against onnxruntime CPU), while wasm matches and takes about 1 s.
      const sess = await ort.InferenceSession.create(buf, {
        executionProviders: [model === "full" ? "webgpu" : "wasm"],
        graphOptimizationLevel: "all",
      });
      if (model === "full") {
        // Warm-up compiles the WebGPU shaders so the first real image is fast.
        const t = new ort.Tensor("float32", new Float32Array(3 * ISNET_SIZE * ISNET_SIZE), [1, 3, ISNET_SIZE, ISNET_SIZE]);
        const out = await sess.run({ [sess.inputNames[0]]: t });
        Object.values(out).forEach((v) => v.dispose?.());
      }
      self.postMessage({ type: "ready", model });
      return sess;
    })();
    sessions[model] = s;
    s.catch(() => delete sessions[model]);
  }
  return s;
}

function fit(w: number, h: number) {
  if (w * h <= MAX_PIXELS) return [w, h];
  const s = Math.sqrt(MAX_PIXELS / (w * h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/** MODNet input size: shortest edge 512, longest capped at 1024, both multiples of 32. */
function modnetSize(w: number, h: number) {
  const s = Math.min(512 / Math.min(w, h), 1024 / Math.max(w, h));
  const r = (v: number) => Math.max(32, Math.round((v * s) / 32) * 32);
  return [r(w), r(h)];
}

async function cutout(src: ImageBitmap, model: Model) {
  const s = await getSession(model);
  const t1 = performance.now();
  const [W, H] = fit(src.width, src.height);

  // Full-res source pixels.
  const full = new OffscreenCanvas(W, H);
  const fctx = full.getContext("2d", { willReadFrequently: true })!;
  fctx.drawImage(src, 0, 0, W, H);
  const img = fctx.getImageData(0, 0, W, H);

  const [mw, mh] = model === "full" ? [ISNET_SIZE, ISNET_SIZE] : modnetSize(W, H);
  const small = new OffscreenCanvas(mw, mh);
  const sctx = small.getContext("2d", { willReadFrequently: true })!;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(src, 0, 0, mw, mh);
  const px = sctx.getImageData(0, 0, mw, mh).data;
  const n = mw * mh;
  const input = new Float32Array(3 * n);
  if (model === "full") {
    // ISNet normalisation: x / max - 0.5
    let max = 1;
    for (let i = 0; i < n * 4; i++) if ((i & 3) !== 3 && px[i] > max) max = px[i];
    for (let i = 0; i < n; i++) {
      input[i] = px[i * 4] / max - 0.5;
      input[n + i] = px[i * 4 + 1] / max - 0.5;
      input[2 * n + i] = px[i * 4 + 2] / max - 0.5;
    }
  } else {
    // MODNet normalisation: (x / 255 - 0.5) / 0.5
    for (let i = 0; i < n; i++) {
      input[i] = px[i * 4] / 127.5 - 1;
      input[n + i] = px[i * 4 + 1] / 127.5 - 1;
      input[2 * n + i] = px[i * 4 + 2] / 127.5 - 1;
    }
  }
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, mh, mw]) });
  const data = (await out[s.outputNames[0]].getData()) as Float32Array;
  Object.values(out).forEach((t) => t.dispose?.());

  // ISNet: min-max normalise. MODNet already outputs a 0..1 matte.
  let lo = 0;
  let span = 1;
  if (model === "full") {
    lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      if (data[i] < lo) lo = data[i];
      if (data[i] > hi) hi = data[i];
    }
    span = Math.max(hi - lo, 1e-6);
  }
  const mask = new ImageData(mw, mh);
  for (let i = 0; i < n; i++) {
    const a = ((data[i] - lo) / span) * 255;
    const j = i * 4;
    mask.data[j] = mask.data[j + 1] = mask.data[j + 2] = a;
    mask.data[j + 3] = 255;
  }
  sctx.putImageData(mask, 0, 0);
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
  return { png, bitmap, ms: Math.round(performance.now() - t1) };
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === "preload") {
    getSession(msg.model).catch((err) => self.postMessage({ type: "error", model: msg.model, message: String(err?.message || err) }));
  } else if (msg.type === "cutout") {
    try {
      const r = await cutout(msg.bitmap, msg.model);
      msg.bitmap.close();
      self.postMessage({ type: "result", id: msg.id, ...r }, [r.bitmap]);
    } catch (err) {
      self.postMessage({ type: "error", id: msg.id, message: String((err as Error)?.message || err) });
    }
  }
};
