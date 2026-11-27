# nobg

Free background remover at **[nobg.here](https://nobg.here)**: TinyPNG-style zero friction, with remove.bg-style polish.

- **Web (Vercel, `web/`)**: Next.js and Tailwind. Drop, paste or pick a sample, watch the cutout reveal, compare it with a
  before/after slider, swap the background (transparent, colours, custom, blur) and download a full-resolution PNG.
- **On-device first**: with WebGPU, cutouts run in the browser (ISNet fp16, about 0.5 s for 1.6 MP and 1.3 s for 12 MP on an
  M-series Mac). The model downloads once (90 MB) and is cached. Server cost: $0.
- **Server fallback and API (ubuntu2, `server/`)**: FastAPI with ONNX Runtime on CPU (about 3–5 s per image), Redis and Postgres,
  exposed only through a Cloudflare Tunnel at `api.nobg.here`. Uploads go straight from the browser to the API, never
  through Vercel (4.5 MB body cap).

```
browser ──(WebGPU)──> cutout on device               model: api.nobg.here/models/*.bin (immutable, CF edge-cached)
   └──(no WebGPU)──> api.nobg.here ─ CF Tunnel ─> nobg-tunnel ─(internal net)─> nobg-api ─(internal net)─> redis, postgres
```

## Quality pipeline (identical on device and server)

1. ISNet-general (DIS, Apache-2.0) matte at 1024×1024.
2. Bilinear upscale of the matte to the original resolution (up to 16 MP).
3. Two-pass blur-fusion foreground estimation removes background colour spill from hair and soft edges.
   The browser computes the smooth fields at ≤1024 px and combines them at full resolution, which keeps memory low.

Device and server output differ by less than 1/255 in alpha on average.

**Why not BiRefNet?** It was benchmarked on ubuntu2 at 16 s and 6.8 GB of RAM per image on CPU, which is too heavy next to
Home Assistant. In the browser, ONNX Runtime Web's WebGPU kernels exceed Chrome's 10-storage-buffer limit on its wide
Split/Concat nodes. Rewriting those nodes fixes that, but the model then runs out of WASM heap. Revisit when ORT-web
improves or with a GPU host. `NEXT_PUBLIC_MODEL_URL` lets you swap the browser model without code changes.

## Containment on ubuntu2

`docker-compose.yml` (project `nobg`, nothing shared with other stacks):

- `nobg-api` parses untrusted uploads, so it sits **only on internal networks**. It has no route to the internet, the LAN
  (Home Assistant etc.) or the host (verified). It also has no published ports.
- `nobg-tunnel` (cloudflared) is the only container with egress, and it can reach only the API.
- Redis has no persistence. Postgres lives in `./data/postgres`. Both are internal-only.
- Every container: read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, non-root user, memory/CPU/PID caps
  (API: 3 GB, 4 CPUs, at most 2 concurrent inferences, 6 queued, then 503).
- Images are held in RAM only. Async jobs keep input and result in Redis with a 1 h TTL.

## Operate

```bash
./deploy.sh                 # rsync to spencer@ubuntu2:~/nobg, fetch/build models, docker compose up
./deploy.sh --public        # same, plus the Cloudflare tunnel (needs TUNNEL_TOKEN in ~/nobg/.env)

# on ubuntu2, in ~/nobg
docker compose exec api python -m app.admin create-key you@example.com --plan personal --label laptop
docker compose exec api python -m app.admin list
docker compose exec api python -m app.admin revoke bg_live_AbCd
./smoke.sh photo.jpg out.png                       # test through the private network
docker compose --profile local up -d               # optional 127.0.0.1:8514 door for local dev (ssh -L 8514:localhost:8514 ubuntu2)
```

`DATABASE_URL` in `.env` can point to Neon or Supabase to move state off the box. The schema (`db/schema.sql`) is applied on
startup. Moving to a VPS or GPU host means copying `.env`, running `./deploy.sh --public`, and letting both tunnel replicas
overlap.

### Cloudflare tunnel (one-time)

Zero Trust → Networks → Tunnels → Create tunnel (cloudflared) named `nobg`. Add the public hostname
`api.nobg.here` → service `http://nobg-api:8000`. Put the token in `~/nobg/.env` as `TUNNEL_TOKEN=` and run
`./deploy.sh --public`.

## Web

```bash
cd web && pnpm install && pnpm dev     # NEXT_PUBLIC_API_URL=http://localhost:8514 in .env.local to use the local door
```

Env: `NEXT_PUBLIC_API_URL` (default `https://api.nobg.here`), `NEXT_PUBLIC_MODEL_URL` (default `<api>/models/isnet-fp16-281bde9e.bin`).
Add `?server` to the URL to force the server path.

## API

See [nobg.here/developers](https://nobg.here/developers). `POST /v1/remove` (multipart `image_file` or raw body, as in
remove.bg), `POST /v1/jobs` + `GET /v1/jobs/{id}[/result]`, `GET /v1/usage`. Keys are `bg_live_…`, stored as SHA-256.
Limits use Redis sliding windows per key (free 10/min and 100/day, personal 30/1,000, pro 60/10,000) and per IP for
the web fallback (8/min, 60/day).
