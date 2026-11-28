// Model locations, shared by the page and the worker. Files are content-addressed and immutable.
export type Model = "full" | "quick";

const API = (process.env.NEXT_PUBLIC_API_URL || "https://api.nobg.here").replace(/\/$/, "");

export const MODELS: Record<Model, { url: string; bytes: number }> = {
  // ISNet-general, fp16 weights (Apache-2.0). Same model as the server.
  full: { url: process.env.NEXT_PUBLIC_MODEL_URL || `${API}/models/isnet-fp16-281bde9e.bin`, bytes: 90_447_799 },
  // MODNet portrait matting, fp16 (Apache-2.0). Instant preview while `full` downloads.
  quick: { url: process.env.NEXT_PUBLIC_QUICK_MODEL_URL || `${API}/models/modnet-fp16-25f165da.bin`, bytes: 12_984_781 },
};

export const MODEL_CACHE = "nobg-models-v2";

export async function isCached(model: Model) {
  try {
    return !!(await (await caches.open(MODEL_CACHE)).match(MODELS[model].url));
  } catch {
    return false;
  }
}
