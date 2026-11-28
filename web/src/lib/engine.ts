"use client";
// Chooses where a cutout runs: on-device (WebGPU worker) when possible, otherwise the
// nobg server via Cloudflare Tunnel. Uploads go straight to the API, never through Vercel.
// On a first visit the 90 MB ISNet model isn't cached yet, so a 13 MB MODNet preview is shown
// within about a second, then replaced by the full cutout once ISNet has downloaded.
import { isCached, type Model } from "./models";

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "https://api.nobg.here").replace(/\/$/, "");

export type Where = "device" | "server";
export type CutoutResult = { png: Blob; bitmap: ImageBitmap; ms: number; where: Where; width: number; height: number; preview?: boolean };
export type Progress =
  | { phase: "download"; model: Model; loaded: number; total: number; cached?: boolean }
  | { phase: "processing"; where: Where };

let worker: Worker | null = null;
let gpuOk: Promise<boolean> | null = null;
const ready = new Set<Model>();
const listeners = new Set<(p: Progress) => void>();
const pending = new Map<number, { resolve: (v: Omit<CutoutResult, "where" | "width" | "height">) => void; reject: (e: Error) => void }>();
let nextId = 1;

export function onProgress(fn: (p: Progress) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
const emit = (p: Progress) => listeners.forEach((fn) => fn(p));

export function isModelReady(model: Model = "full") {
  return ready.has(model);
}

/** True when the full model still has to be downloaded, so a quick preview is worth it. */
async function needsPreview() {
  return !ready.has("full") && !(await isCached("full"));
}

export function hasWebGPU(): Promise<boolean> {
  if (!gpuOk) {
    gpuOk = (async () => {
      if (typeof navigator === "undefined" || !("gpu" in navigator)) return false;
      if (new URLSearchParams(location.search).has("server")) return false; // ?server forces the fallback
      try {
        const adapter = await (navigator as Navigator & { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter();
        return !!adapter;
      } catch {
        return false;
      }
    })();
  }
  return gpuOk;
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./cutout.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "progress") emit({ phase: "download", model: m.model, loaded: m.loaded, total: m.total, cached: m.cached });
    else if (m.type === "ready") ready.add(m.model);
    else if (m.type === "result") {
      pending.get(m.id)?.resolve({ png: m.png, bitmap: m.bitmap, ms: m.ms });
      pending.delete(m.id);
    } else if (m.type === "error") {
      if (m.id) {
        pending.get(m.id)?.reject(new Error(m.message));
        pending.delete(m.id);
      } else console.warn(`[nobg] ${m.model} model failed to load:`, m.message);
    }
  };
  worker.onerror = (e) => {
    pending.forEach((p) => p.reject(new Error(e.message || "worker crashed")));
    pending.clear();
    worker?.terminate();
    worker = null;
  };
  return worker;
}

/** Start fetching the on-device model early (hover / focus / sample click). */
let preloaded = false;
export async function preload() {
  if (preloaded || !(await hasWebGPU())) return;
  preloaded = true;
  const w = getWorker();
  if (await needsPreview()) w.postMessage({ type: "preload", model: "quick" }); // small one first
  w.postMessage({ type: "preload", model: "full" });
}

async function onDevice(file: Blob, model: Model = "full"): Promise<CutoutResult> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const { width, height } = bitmap;
  const id = nextId++;
  const w = getWorker();
  const r = await new Promise<Omit<CutoutResult, "where" | "width" | "height">>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ type: "cutout", id, model, bitmap }, [bitmap]);
  });
  return { ...r, where: "device", width: r.bitmap.width || width, height: r.bitmap.height || height };
}

export class ServerError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function onServer(file: Blob): Promise<CutoutResult> {
  const t0 = performance.now();
  const body = new FormData();
  body.append("image_file", file, (file as File).name || "image");
  let res: Response;
  try {
    res = await fetch(`${API_URL}/web/remove`, { method: "POST", body });
  } catch {
    throw new ServerError("Couldn't reach the nobg server. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    let msg = `Server error (${res.status}).`;
    try {
      msg = (await res.json()).error?.message || msg;
    } catch {}
    throw new ServerError(msg, res.status);
  }
  const png = await res.blob();
  const bitmap = await createImageBitmap(png);
  return { png, bitmap, ms: Math.round(performance.now() - t0), where: "server", width: bitmap.width, height: bitmap.height };
}

/**
 * onPreview, if given, may be called once with a quick MODNet cutout before the final result,
 * when the full model isn't downloaded yet. The final (ISNet) result is what this resolves to.
 */
export async function removeBackground(file: Blob, onPreview?: (r: CutoutResult) => void): Promise<CutoutResult> {
  if (await hasWebGPU()) {
    try {
      emit({ phase: "processing", where: "device" });
      if (onPreview && (await needsPreview())) {
        preload();
        let done = false;
        onDevice(file, "quick")
          .then((r) => (done ? r.bitmap.close() : onPreview({ ...r, preview: true })))
          .catch((e) => console.warn("[nobg] quick preview failed:", e));
        try {
          return await onDevice(file);
        } finally {
          done = true;
        }
      }
      return await onDevice(file);
    } catch (e) {
      console.warn("[nobg] on-device cutout failed, using server:", e);
    }
  }
  emit({ phase: "processing", where: "server" });
  return onServer(file);
}
