"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { hasWebGPU, isModelReady, onProgress, preload, removeBackground, type CutoutResult, type Where } from "@/lib/engine";

type Bg = { kind: "none" } | { kind: "color"; color: string } | { kind: "blur" };
type Dl = { loaded: number; total: number };
type Dls = { quick?: Dl; full?: Dl };
type State =
  | { s: "idle" }
  | { s: "working"; src: string; name: string; file: Blob; where?: Where; dl?: Dls }
  | { s: "done"; src: string; name: string; file: Blob; out: string; res: CutoutResult; dl?: Dls }
  | { s: "error"; src?: string; name?: string; file?: Blob; message: string };

const SAMPLES = [
  { id: "portrait", label: "Portrait" },
  { id: "dog", label: "Dog" },
  { id: "headphones", label: "Product" },
  { id: "cat", label: "Cat" },
];
const COLORS = ["#ffffff", "#000000", "#f4efe6", "#dbe8ff", "#ffe0d6", "#d9f2e3"];
const ACCEPT = "image/png,image/jpeg,image/webp,image/avif,image/gif,image/bmp";

function baseName(name: string) {
  return (name.replace(/\.[^.]+$/, "") || "image").slice(0, 60);
}

function fmtMB(n: number) {
  return `${(n / 1e6).toFixed(0)} MB`;
}

function fmtTime(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)}s`;
}

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Cheap, Safari-safe blur: downscale then upscale with smoothing, twice. */
function blurred(src: CanvasImageSource, W: number, H: number) {
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const ctx = out.getContext("2d")!;
  const k = Math.max(W, H) / 48;
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.round(W / k));
  small.height = Math.max(1, Math.round(H / k));
  const sctx = small.getContext("2d")!;
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(src, 0, 0, small.width, small.height);
  ctx.imageSmoothingQuality = "high";
  // Overscan slightly so the edges don't fade.
  const pad = Math.max(W, H) * 0.04;
  ctx.drawImage(small, -pad, -pad, W + 2 * pad, H + 2 * pad);
  return out;
}

async function composite(res: CutoutResult, original: Blob, bg: Bg): Promise<Blob> {
  const { width: W, height: H } = res.bitmap;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  if (bg.kind === "color") {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, W, H);
  } else if (bg.kind === "blur") {
    const orig = await createImageBitmap(original, { imageOrientation: "from-image" });
    ctx.drawImage(blurred(orig, W, H), 0, 0);
    orig.close();
  }
  ctx.drawImage(res.bitmap, 0, 0, W, H);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", 0.92));
}

export default function Tool() {
  const [state, setState] = useState<State>({ s: "idle" });
  const [bg, setBg] = useState<Bg>({ kind: "none" });
  const [pos, setPos] = useState(1); // fraction of width showing the result (from the left)
  const [dragOver, setDragOver] = useState(false);
  const [gpu, setGpu] = useState<boolean | null>(null);
  const [busyDl, setBusyDl] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const run = useRef(0);
  const urls = useRef<string[]>([]);

  useEffect(() => {
    hasWebGPU().then(setGpu);
    return onProgress((p) => {
      setState((st) => {
        if (p.phase === "download") {
          if (st.s !== "working" && !(st.s === "done" && st.res.preview)) return st;
          const dl = { ...st.dl, [p.model]: p.loaded >= p.total ? undefined : { loaded: p.loaded, total: p.total } };
          return { ...st, dl };
        }
        return st.s === "working" ? { ...st, where: p.where } : st;
      });
    });
  }, []);

  // Bring the stage into view when work starts (the hero can push it below the fold).
  const working = state.s === "working";
  useEffect(() => {
    if (working) stage.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [working]);

  const keepUrl = (u: string) => {
    urls.current.push(u);
    return u;
  };
  const clearUrls = () => {
    urls.current.forEach((u) => URL.revokeObjectURL(u));
    urls.current = [];
  };

  const process = useCallback(async (file: Blob, name: string) => {
    const id = ++run.current;
    if (!file.type.startsWith("image/")) {
      setState({ s: "error", message: "That doesn’t look like an image. Try a JPG, PNG or WebP." });
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      setState({ s: "error", message: "That image is over 25 MB. Try a smaller one." });
      return;
    }
    clearUrls();
    const src = keepUrl(URL.createObjectURL(file));
    setPos(1);
    setState({ s: "working", src, name, file });
    const reveal = () => {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) return setPos(1);
      setPos(0);
      const t0 = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / 900);
        setPos(k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
        if (k < 1 && id === run.current) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    let shown = false;
    try {
      const res = await removeBackground(file, (preview) => {
        if (id !== run.current) return preview.bitmap.close();
        const out = keepUrl(URL.createObjectURL(preview.png));
        setState((st) => ({ s: "done", src, name, file, out, res: preview, dl: st.s === "working" ? st.dl : undefined }));
        shown = true;
        reveal();
      });
      if (id !== run.current) return;
      const out = keepUrl(URL.createObjectURL(res.png));
      setState((st) => {
        if (st.s === "done" && st.res.preview) st.res.bitmap.close();
        return { s: "done", src, name, file, out, res };
      });
      if (!shown) reveal();
    } catch (e) {
      if (id !== run.current) return;
      setState({ s: "error", src, name, file, message: (e as Error).message || "Something went wrong." });
    }
  }, []);

  const takeFiles = useCallback(
    (files: FileList | File[] | null | undefined) => {
      const f = files && Array.from(files).find((x) => x.type.startsWith("image/"));
      if (f) process(f, baseName(f.name));
      else if (files && files.length) setState({ s: "error", message: "That doesn’t look like an image. Try a JPG, PNG or WebP." });
    },
    [process],
  );

  // Global paste + full-window drag and drop.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.files || []);
      if (items.length) {
        e.preventDefault();
        takeFiles(items);
      }
    };
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragOver(true);
      preload();
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragOver(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragOver(false);
      takeFiles(e.dataTransfer?.files);
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [takeFiles]);

  const trySample = async (id: string) => {
    preload();
    const blob = await (await fetch(`/samples/${id}.jpg`)).blob();
    process(blob, id);
  };

  const reset = () => {
    run.current++;
    clearUrls();
    setState({ s: "idle" });
    setBg({ kind: "none" });
  };

  // Before/after slider drag.
  const dragTo = (clientX: number) => {
    const r = stage.current?.getBoundingClientRect();
    if (r) setPos(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (state.s !== "done") return;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragTo(e.clientX);
  };

  const download = async (withBg: boolean) => {
    if (state.s !== "done") return;
    if (!withBg || bg.kind === "none") return save(state.res.png, `${state.name}-nobg.png`);
    setBusyDl(true);
    try {
      save(await composite(state.res, state.file, bg), `${state.name}-nobg.jpg`);
    } finally {
      setBusyDl(false);
    }
  };

  const view = state.s === "idle" || (state.s === "error" && !state.src) ? "pick" : "stage";

  return (
    <div className="mx-auto w-full max-w-6xl px-5">
      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-accent/10 backdrop-blur-[2px]">
          <div className="pop-in rounded-3xl border-2 border-dashed border-accent bg-card px-10 py-8 font-display text-2xl font-extrabold">
            Drop it. We’ll do the rest.
          </div>
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          takeFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {view === "pick" ? (
        <section className="pop-in">
          <div
            onPointerEnter={() => preload()}
            onClick={() => fileInput.current?.click()}
            className="group relative grid cursor-pointer place-items-center rounded-[28px] border-2 border-dashed border-line bg-card px-6 py-16 text-center transition hover:border-accent sm:py-24"
          >
            <div className="checker mb-6 grid size-16 place-items-center rounded-2xl ring-1 ring-line transition group-hover:rotate-[-4deg] group-hover:scale-105">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 16V4m0 0-4 4m4-4 4 4M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
              </svg>
            </div>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                fileInput.current?.click();
              }}
              onFocus={() => preload()}
              className="rounded-full bg-accent px-8 py-4 text-lg font-semibold text-accent-ink shadow-[0_8px_24px_-8px_var(--accent)] transition hover:brightness-105 active:scale-[0.98]"
            >
              Upload Image
            </button>
            <p className="mt-4 text-sm text-muted">
              or drop a file anywhere, or paste with <kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-xs">⌘V</kbd>
            </p>
          </div>

          {state.s === "error" && <p className="mt-4 rounded-xl bg-accent-soft px-4 py-3 text-sm">{state.message}</p>}

          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <p className="text-sm text-muted">No image? Try one:</p>
            <div className="flex gap-3">
              {SAMPLES.map((x) => (
                <button
                  key={x.id}
                  onPointerEnter={() => preload()}
                  onClick={() => trySample(x.id)}
                  className="group overflow-hidden rounded-xl ring-1 ring-line transition hover:-translate-y-0.5 hover:ring-2 hover:ring-accent"
                  aria-label={`Try the ${x.label.toLowerCase()} sample`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/samples/${x.id}-thumb.jpg`} alt="" className="size-16 object-cover sm:size-20" />
                </button>
              ))}
            </div>
          </div>
        </section>
      ) : (
        <section className="pop-in grid gap-6 lg:grid-cols-[1fr_300px]">
          {/* Stage */}
          <div className="rounded-[28px] border border-line bg-card p-3 sm:p-4">
            <div
              ref={stage}
              onPointerDown={onPointerDown}
              onPointerMove={(e) => e.buttons === 1 && state.s === "done" && dragTo(e.clientX)}
              className={`relative mx-auto w-fit max-w-full touch-none select-none overflow-hidden rounded-2xl ${state.s === "done" ? "cursor-ew-resize" : ""}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={state.s !== "idle" ? state.src : undefined} alt="Original" className="block max-h-[68vh] w-auto max-w-full" draggable={false} />

              {state.s === "working" && (
                <div className={`absolute inset-0 ${state.dl?.quick || state.dl?.full ? "shimmer bg-ink/20" : "sweep"}`} aria-hidden />
              )}

              {state.s === "done" && (
                <div className="absolute inset-0" style={{ clipPath: `inset(0 ${(1 - pos) * 100}% 0 0)` }}>
                  {bg.kind === "none" && <div className="checker absolute inset-0" />}
                  {bg.kind === "color" && <div className="absolute inset-0" style={{ background: bg.color }} />}
                  {bg.kind === "blur" && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={state.src} alt="" className="absolute inset-0 size-full scale-110 object-cover blur-xl" draggable={false} />
                  )}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={state.out} alt="Background removed" className="absolute inset-0 size-full" draggable={false} />
                </div>
              )}

              {state.s === "done" && (
                <div
                  className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.15)]"
                  style={{ left: `clamp(14px, ${pos * 100}%, calc(100% - 14px))` }}
                >
                  <div className="absolute top-1/2 left-1/2 grid size-8 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-ink shadow-md">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                      <path d="m9 6-6 6 6 6M15 6l6 6-6 6" />
                    </svg>
                  </div>
                </div>
              )}
            </div>

            {state.s === "working" && (
              <div className="mx-auto mt-4 max-w-md text-center text-sm" aria-live="polite">
                {state.dl?.quick ? (
                  <>
                    <p className="font-medium">Loading the quick preview…</p>
                    <Bar dl={state.dl.quick} />
                  </>
                ) : state.dl?.full ? (
                  <>
                    <p className="font-medium">Warming up the AI engine (one-time setup)…</p>
                    <Bar dl={state.dl.full} />
                    <p className="mt-1.5 text-xs text-muted">
                      {fmtMB(state.dl.full.loaded)} of {fmtMB(state.dl.full.total)}. After this, cutouts take about a second.
                    </p>
                  </>
                ) : (
                  <p className="text-muted">
                    {state.where === "server" ? "Cutting it out on the nobg server…" : gpu && !isModelReady() ? "Starting the AI engine…" : "Cutting it out…"}
                  </p>
                )}
              </div>
            )}
            {state.s === "done" && pos > 0.97 && (
              <p className="mt-3 text-center text-xs text-muted">Drag across the image to compare with the original.</p>
            )}
          </div>

          {/* Side panel */}
          <aside className="flex flex-col gap-5">
            {state.s === "error" && (
              <div className="rounded-2xl bg-accent-soft p-4 text-sm">
                <p>{state.message}</p>
                {state.file && (
                  <button className="mt-3 font-semibold underline" onClick={() => process(state.file!, state.name || "image")}>
                    Try again
                  </button>
                )}
              </div>
            )}

            {state.s === "done" && state.res.preview && (
              <div className="pop-in" aria-live="polite">
                <p className="font-display text-2xl font-extrabold">Quick preview</p>
                <p className="mt-1 text-sm text-muted">
                  Ready in {fmtTime(state.res.ms)} on your device. Sharpening it with the full model (one-time download)…
                </p>
                {state.dl?.full ? (
                  <>
                    <Bar dl={state.dl.full} />
                    <p className="mt-1.5 text-xs text-muted">
                      {fmtMB(state.dl.full.loaded)} of {fmtMB(state.dl.full.total)}
                    </p>
                  </>
                ) : (
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
                    <div className="sweep h-full w-full rounded-full" />
                  </div>
                )}
              </div>
            )}

            {state.s === "done" && !state.res.preview && (
              <div className="pop-in">
                <p className="font-display text-2xl font-extrabold">Clean cut in {fmtTime(state.res.ms)}</p>
                <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
                  {state.res.where === "device" ? (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                        <rect x="5" y="11" width="14" height="10" rx="2" />
                        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                      </svg>
                      Processed privately on your device
                    </>
                  ) : (
                    <>Processed on the nobg server. Not stored.</>
                  )}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {state.res.width} × {state.res.height} px
                </p>
              </div>
            )}

            {state.s === "done" && (
              <div>
                <p className="mb-2 text-sm font-medium">Background</p>
                <div className="flex flex-wrap gap-2">
                  <Swatch active={bg.kind === "none"} onClick={() => setBg({ kind: "none" })} label="Transparent" className="checker" />
                  {COLORS.map((c) => (
                    <Swatch key={c} active={bg.kind === "color" && bg.color === c} onClick={() => setBg({ kind: "color", color: c })} label={c} style={{ background: c }} />
                  ))}
                  <label
                    className={`relative grid size-9 cursor-pointer place-items-center overflow-hidden rounded-full ring-1 ring-line ${bg.kind === "color" && !COLORS.includes(bg.color) ? "ring-2 ring-accent ring-offset-2 ring-offset-paper" : ""}`}
                    style={{ background: "conic-gradient(red, yellow, lime, cyan, blue, magenta, red)" }}
                    title="Custom color"
                  >
                    <input
                      type="color"
                      className="absolute inset-0 cursor-pointer opacity-0"
                      onChange={(e) => setBg({ kind: "color", color: e.target.value })}
                      aria-label="Custom background color"
                    />
                  </label>
                  <Swatch active={bg.kind === "blur"} onClick={() => setBg({ kind: "blur" })} label="Blurred original" className="overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={state.src} alt="" className="size-full scale-150 object-cover blur-[3px]" />
                  </Swatch>
                </div>
              </div>
            )}

            {state.s === "done" && (
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => download(false)}
                  className="rounded-full bg-accent px-6 py-4 text-lg font-semibold text-accent-ink shadow-[0_8px_24px_-8px_var(--accent)] transition hover:brightness-105 active:scale-[0.98]"
                >
                  Download PNG
                </button>
                {bg.kind !== "none" && (
                  <button
                    onClick={() => download(true)}
                    disabled={busyDl}
                    className="rounded-full border border-line bg-card px-6 py-3 font-semibold transition hover:border-ink disabled:opacity-60"
                  >
                    {busyDl ? "Preparing…" : "Download with background"}
                  </button>
                )}
                <p className="text-center text-xs text-muted">Full resolution. No watermark.</p>
              </div>
            )}

            {(state.s === "done" || state.s === "error") && (
              <div className="flex flex-col gap-2 border-t border-line pt-4 text-sm">
                <button onClick={() => fileInput.current?.click()} className="rounded-full border border-line px-5 py-2.5 font-medium hover:border-ink">
                  New image
                </button>
                <button onClick={reset} className="text-muted hover:text-ink">
                  Start over
                </button>
              </div>
            )}
          </aside>
        </section>
      )}
    </div>
  );
}

function Bar({ dl }: { dl: Dl }) {
  return (
    <div className="mt-2 h-2 overflow-hidden rounded-full bg-line">
      <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${(dl.loaded / dl.total) * 100}%` }} />
    </div>
  );
}

function Swatch({
  active,
  onClick,
  label,
  className = "",
  style,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`size-9 rounded-full ring-1 ring-line transition hover:scale-110 ${active ? "ring-2 ring-accent ring-offset-2 ring-offset-paper" : ""} ${className}`}
      style={style}
    >
      {children}
    </button>
  );
}
