import type { Metadata } from "next";

export const metadata: Metadata = { title: "API — nobg", description: "nobg background removal REST API." };

const API = "https://api.nobg.here";

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-xl bg-ink p-4 font-mono text-[13px] leading-relaxed text-paper">
      <code>{children}</code>
    </pre>
  );
}

function Endpoint({ method, path, children }: { method: string; path: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line py-8">
      <h2 className="font-mono text-base font-semibold">
        <span className="mr-2 rounded-md bg-accent-soft px-2 py-0.5 text-accent">{method}</span>
        {path}
      </h2>
      <div className="mt-3 space-y-3 text-sm text-muted [&_code]:font-mono [&_code]:text-ink">{children}</div>
    </section>
  );
}

export default function Developers() {
  return (
    <article className="mx-auto max-w-3xl px-5 pt-6 pb-10">
      <h1 className="font-display text-4xl font-extrabold tracking-tight">API</h1>
      <p className="mt-3 text-muted">
        A small REST API for scripts and apps. Base URL <code className="font-mono text-ink">{API}</code>. Keys are invite-only
        for now. Send them as <code className="font-mono text-ink">X-Api-Key</code> (or <code className="font-mono text-ink">Authorization: Bearer</code>).
        Images are processed in memory and never stored. Async results expire after one hour.
      </p>

      <div className="mt-6 overflow-hidden rounded-xl border border-line text-sm">
        <table className="w-full">
          <thead className="bg-card text-left">
            <tr>
              <th className="px-4 py-2 font-medium">Plan</th>
              <th className="px-4 py-2 font-medium">Per minute</th>
              <th className="px-4 py-2 font-medium">Per day</th>
            </tr>
          </thead>
          <tbody className="text-muted">
            <tr className="border-t border-line"><td className="px-4 py-2">free</td><td className="px-4 py-2">10</td><td className="px-4 py-2">100</td></tr>
            <tr className="border-t border-line"><td className="px-4 py-2">personal</td><td className="px-4 py-2">30</td><td className="px-4 py-2">1,000</td></tr>
            <tr className="border-t border-line"><td className="px-4 py-2">pro</td><td className="px-4 py-2">60</td><td className="px-4 py-2">10,000</td></tr>
          </tbody>
        </table>
      </div>

      <Endpoint method="POST" path="/v1/remove">
        <p>
          Synchronous cutout. Upload as multipart field <code>image_file</code> (same as remove.bg) or as a raw{" "}
          <code>image/*</code> body. Max 25 MB; images over 16 MP are scaled down. Returns a transparent PNG at the original size, or
          JSON with base64 when you add <code>?format=json</code>.
        </p>
        <Code>{`curl -H "X-Api-Key: $NOBG_KEY" \\
  -F image_file=@photo.jpg \\
  -o photo-nobg.png ${API}/v1/remove`}</Code>
        <Code>{`import requests
r = requests.post("${API}/v1/remove",
    headers={"X-Api-Key": KEY},
    files={"image_file": open("photo.jpg", "rb")})
r.raise_for_status()
open("photo-nobg.png", "wb").write(r.content)`}</Code>
        <p>
          Response headers: <code>X-Width</code>, <code>X-Height</code>, <code>X-Processing-Ms</code>,{" "}
          <code>X-RateLimit-Remaining-Minute</code>, <code>X-RateLimit-Remaining-Day</code>.
        </p>
      </Endpoint>

      <Endpoint method="POST" path="/v1/jobs">
        <p>Async cutout for big images or batches. Takes the same upload. Returns <code>202</code> with a job id.</p>
        <Code>{`curl -H "X-Api-Key: $NOBG_KEY" -F image_file=@big.jpg ${API}/v1/jobs
# {"id":"c109a9…","status":"queued"}`}</Code>
      </Endpoint>

      <Endpoint method="GET" path="/v1/jobs/{id}">
        <p>
          Status is <code>queued</code>, <code>processing</code>, <code>done</code> or <code>failed</code>. When it’s done, fetch{" "}
          <code>/v1/jobs/{"{id}"}/result</code> to get the PNG.
        </p>
        <Code>{`{"id":"c109a9…","status":"done","width":1600,"height":1067,
 "processing_ms":4342,"result_url":"/v1/jobs/c109a9…/result"}`}</Code>
      </Endpoint>

      <Endpoint method="GET" path="/v1/usage">
        <Code>{`{"plan":"free","limits":{"per_minute":10,"per_day":100},
 "remaining":{"minute":9,"day":97},"total_requests":3}`}</Code>
      </Endpoint>

      <section className="border-t border-line py-8 text-sm text-muted">
        <h2 className="font-display text-lg font-extrabold text-ink">Errors</h2>
        <p className="mt-2">
          Errors come back as <code className="font-mono text-ink">{`{"error":{"status":429,"message":"…"}}`}</code>.{" "}
          <code className="font-mono text-ink">401</code> means a bad key, <code className="font-mono text-ink">413</code> a file that’s too big,{" "}
          <code className="font-mono text-ink">422</code> an unreadable image, <code className="font-mono text-ink">429</code> a rate limit (see{" "}
          <code className="font-mono text-ink">Retry-After</code>), and <code className="font-mono text-ink">503</code> a busy server (retry shortly).
        </p>
      </section>
    </article>
  );
}
