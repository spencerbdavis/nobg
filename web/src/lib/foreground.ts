// Blur-fusion foreground estimation (approximate Fast Multi-Level Foreground Estimation),
// the same 2-pass method the server uses. The blurred foreground/background fields are
// smooth, so they're computed at <=1024px and upsampled; only the final per-pixel
// combination runs at full resolution. This keeps memory small enough for phones.

const WORK = 1024;

function boxBlur(src: Float32Array, w: number, h: number, k: number, tmp: Float32Array, out: Float32Array) {
  const r = Math.max(1, k >> 1);
  // Horizontal pass: src -> tmp
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    let count = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) {
      sum += src[row + x];
      count++;
    }
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / count;
      const add = x + r + 1;
      const sub = x - r;
      if (add < w) {
        sum += src[row + add];
        count++;
      }
      if (sub >= 0) {
        sum -= src[row + sub];
        count--;
      }
    }
  }
  // Vertical pass: tmp -> out
  for (let x = 0; x < w; x++) {
    let sum = 0;
    let count = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) {
      sum += tmp[y * w + x];
      count++;
    }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / count;
      const add = y + r + 1;
      const sub = y - r;
      if (add < h) {
        sum += tmp[add * w + x];
        count++;
      }
      if (sub >= 0) {
        sum -= tmp[sub * w + x];
        count--;
      }
    }
  }
}

function resample(src: CanvasImageSource, w: number, h: number) {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

function toCanvas(data: ImageData) {
  const c = new OffscreenCanvas(data.width, data.height);
  c.getContext("2d")!.putImageData(data, 0, 0);
  return c;
}

/** img: full-res RGBA (alpha ignored). alpha: full-res RGBA mask (R channel used). Returns RGBA cutout. */
export function foregroundEstimate(img: ImageData, alpha: Uint8ClampedArray, W: number, H: number): ImageData {
  const s = Math.min(1, WORK / Math.max(W, H));
  const w = Math.max(1, Math.round(W * s));
  const h = Math.max(1, Math.round(H * s));
  const n = w * h;

  // Low-res copies of the image and the mask.
  const lo = resample(toCanvas(img), w, h).data;
  const maskFull = new ImageData(W, H);
  maskFull.data.set(alpha);
  const loA = resample(toCanvas(maskFull), w, h).data;

  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = loA[i * 4] / 255;

  const side = Math.max(w, h) / 1024;
  const r1 = Math.max(3, Math.round(90 * side));
  const r2 = Math.max(3, Math.round(6 * side));
  const tmp = new Float32Array(n);
  const bA1 = new Float32Array(n);
  const bA2 = new Float32Array(n);
  boxBlur(a, w, h, r1, tmp, bA1);
  boxBlur(a, w, h, r2, tmp, bA2);

  const I = new Float32Array(n);
  const x = new Float32Array(n);
  const bF = new Float32Array(n);
  const bB = new Float32Array(n);
  const F1 = new Float32Array(n);
  const fgField = new ImageData(w, h);
  const bgField = new ImageData(w, h);

  for (let c = 0; c < 3; c++) {
    for (let i = 0; i < n; i++) I[i] = lo[i * 4 + c] / 255;
    // Level 1 (F = B = I)
    for (let i = 0; i < n; i++) x[i] = I[i] * a[i];
    boxBlur(x, w, h, r1, tmp, bF);
    for (let i = 0; i < n; i++) x[i] = I[i] * (1 - a[i]);
    boxBlur(x, w, h, r1, tmp, bB);
    for (let i = 0; i < n; i++) {
      const f = bF[i] / (bA1[i] + 1e-5);
      const b = bB[i] / (1 - bA1[i] + 1e-5);
      bB[i] = b; // B1
      const ai = a[i];
      F1[i] = Math.min(1, Math.max(0, f + ai * (I[i] - ai * f - (1 - ai) * b)));
    }
    // Level 2 blurred fields
    for (let i = 0; i < n; i++) x[i] = F1[i] * a[i];
    boxBlur(x, w, h, r2, tmp, bF);
    for (let i = 0; i < n; i++) x[i] = bB[i] * (1 - a[i]);
    boxBlur(x, w, h, r2, tmp, F1); // reuse F1 as output buffer
    for (let i = 0; i < n; i++) {
      fgField.data[i * 4 + c] = (bF[i] / (bA2[i] + 1e-5)) * 255;
      bgField.data[i * 4 + c] = (F1[i] / (1 - bA2[i] + 1e-5)) * 255;
    }
  }
  for (let i = 0; i < n; i++) fgField.data[i * 4 + 3] = bgField.data[i * 4 + 3] = 255;

  // Upsample the smooth fields and combine at full resolution.
  const FG = resample(toCanvas(fgField), W, H).data;
  const BG = resample(toCanvas(bgField), W, H).data;
  const src = img.data;
  const out = new ImageData(W, H);
  const o = out.data;
  for (let i = 0, N = W * H * 4; i < N; i += 4) {
    const ai = alpha[i] / 255;
    for (let c = 0; c < 3; c++) {
      const f = FG[i + c];
      o[i + c] = f + ai * (src[i + c] - ai * f - (1 - ai) * BG[i + c]);
    }
    o[i + 3] = alpha[i];
  }
  return out;
}
