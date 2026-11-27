import Tool from "@/components/Tool";

export default function Home() {
  return (
    <>
      <section className="mx-auto max-w-3xl px-5 pt-6 pb-8 text-center sm:pt-10">
        <h1 className="font-display text-4xl leading-[1.05] font-extrabold tracking-tight sm:text-6xl">
          Remove the background.
          <br />
          <span className="text-accent">Free, fast, private.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-muted sm:text-lg">
          Clean cutouts in seconds, right in your browser. No sign-up, no watermark, full resolution.
        </p>
      </section>

      <Tool />

      <section className="mx-auto mt-20 grid max-w-6xl gap-6 px-5 sm:grid-cols-3">
        {[
          ["Runs on your device", "With WebGPU, your photo never leaves your computer. Older devices fall back to our server, which keeps nothing."],
          ["Hair-level edges", "A matting model plus colour decontamination, so wispy hair and fur don’t get a halo."],
          ["Built for scripts too", "A small REST API with a remove.bg-style upload field. Personal keys, fair limits."],
        ].map(([t, d]) => (
          <div key={t} className="rounded-2xl border border-line bg-card p-5">
            <h2 className="font-display text-lg font-extrabold">{t}</h2>
            <p className="mt-1.5 text-sm text-muted">{d}</p>
          </div>
        ))}
      </section>
    </>
  );
}
