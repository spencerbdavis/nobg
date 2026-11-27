"""nobg inference API.

Public (via Cloudflare Tunnel at api.nobg.here):
  POST /web/remove            browser fallback, no key, per-IP limits
  POST /v1/remove             API key; sync cutout (PNG or JSON+base64)
  POST /v1/jobs               API key; async cutout, returns job id
  GET  /v1/jobs/{id}          job status
  GET  /v1/jobs/{id}/result   PNG when done
  GET  /v1/usage              remaining quota
  GET  /healthz
  GET  /models/<name>.bin     browser model weights (immutable, edge-cached by Cloudflare)

Stateless: images live only in RAM (and briefly in Redis for async jobs, with a TTL).
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import redis.asyncio as aioredis
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response

from . import db
from .limits import PLAN_LIMITS, WEB_LIMITS, Compute, Limiter
from .pipeline import BadImage, Remover

log = logging.getLogger("nobg")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

MAX_UPLOAD = int(float(os.getenv("NOBG_MAX_UPLOAD_MB", "25")) * 1024 * 1024)
JOB_TTL = 3600
ORIGINS = [o.strip() for o in os.getenv("NOBG_CORS_ORIGINS", "https://nobg.here,http://localhost:3000").split(",") if o.strip()]

state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    state["remover"] = Remover(os.getenv("NOBG_MODEL", "/models/isnet_general.onnx"), int(os.getenv("NOBG_THREADS", "4")))
    await asyncio.to_thread(state["remover"].warmup)
    state["redis"] = aioredis.from_url(os.getenv("REDIS_URL", "redis://redis:6379/0"), socket_timeout=30, socket_connect_timeout=5)
    state["limiter"] = Limiter(state["redis"])
    state["compute"] = Compute()
    await db.init()
    worker = asyncio.create_task(job_worker())
    log.info("ready")
    yield
    worker.cancel()
    await db.close()
    await state["redis"].aclose()


api = FastAPI(title="nobg API", version="1.0", lifespan=lifespan, docs_url=None, redoc_url=None)
api.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Api-Key", "Authorization"],
    expose_headers=["X-Width", "X-Height", "X-Processing-Ms", "X-RateLimit-Remaining-Minute", "X-RateLimit-Remaining-Day", "Retry-After"],
    max_age=86400,
)


# ---------------------------------------------------------------- helpers

def client_ip(request: Request) -> str:
    # Behind Cloudflare Tunnel, CF-Connecting-IP is the real client. Direct access is localhost-only.
    return request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "unknown")


async def read_image(request: Request) -> bytes:
    """Accept multipart field `image_file` (remove.bg compatible) or a raw image/* body."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_UPLOAD + 1024 * 64:
        raise HTTPException(413, f"Image too large (max {MAX_UPLOAD // 1048576} MB).")
    ctype = request.headers.get("content-type", "")
    if ctype.startswith("multipart/form-data"):
        form = await request.form(max_files=1, max_fields=5)
        f = form.get("image_file") or form.get("file")
        if f is None or isinstance(f, str):
            raise HTTPException(400, "Send the image as multipart field `image_file`.")
        data = await f.read(MAX_UPLOAD + 1)
    elif ctype.startswith("image/") or ctype == "application/octet-stream":
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_UPLOAD:
                break
            chunks.append(chunk)
        data = b"".join(chunks)
        if size > MAX_UPLOAD:
            data += b"x"
    else:
        raise HTTPException(415, "Send multipart/form-data with `image_file`, or a raw image/* body.")
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, f"Image too large (max {MAX_UPLOAD // 1048576} MB).")
    if not data:
        raise HTTPException(400, "Empty upload.")
    return data


async def require_key(x_api_key: str | None = Header(None), authorization: str | None = Header(None)) -> db.KeyOwner:
    raw = x_api_key or (authorization[7:] if authorization and authorization.lower().startswith("bearer ") else None)
    if not raw:
        raise HTTPException(401, "Missing API key. Send `X-Api-Key: bg_live_...`.")
    owner = await db.lookup_key(raw.strip())
    if not owner:
        raise HTTPException(401, "Invalid or revoked API key.")
    return owner


def limit_headers(v) -> dict:
    h = {"X-RateLimit-Remaining-Minute": str(max(v.minute_left, 0))}
    if v.day_left >= 0:
        h["X-RateLimit-Remaining-Day"] = str(v.day_left)
    return h


async def enforce(ident: str, per_min: int, per_day: int):
    v = await state["limiter"].hit(ident, per_min, per_day)
    if not v.ok:
        scope = "daily" if v.day_left == 0 else "per-minute"
        raise HTTPException(429, f"Rate limit reached ({scope}). Try again in {v.retry_after}s.",
                            headers={"Retry-After": str(v.retry_after), **limit_headers(v)})
    return v


async def run_cutout(data: bytes):
    compute: Compute = state["compute"]
    if compute.busy:
        raise HTTPException(503, "Server is busy. Try again in a few seconds.", headers={"Retry-After": "5"})
    async with compute:
        try:
            return await asyncio.to_thread(state["remover"].remove, data)
        except BadImage as e:
            raise HTTPException(422, str(e)) from None


def png_response(res, extra: dict) -> Response:
    return Response(res.png, media_type="image/png", headers={
        "X-Width": str(res.width), "X-Height": str(res.height), "X-Processing-Ms": str(res.total_ms),
        "Cache-Control": "no-store", **extra,
    })


@api.exception_handler(HTTPException)
async def http_error(_: Request, exc: HTTPException):
    return JSONResponse({"error": {"status": exc.status_code, "message": exc.detail}}, exc.status_code, headers=exc.headers)


# ---------------------------------------------------------------- routes

@api.get("/healthz")
async def healthz():
    await state["redis"].ping()
    return {"ok": True, "busy": state["compute"].busy}


@api.post("/web/remove")
async def web_remove(request: Request):
    v = await enforce(f"ip:{client_ip(request)}", *WEB_LIMITS)
    data = await read_image(request)
    res = await run_cutout(data)
    await db.log_usage("web_fallback", res.width * res.height / 1e6, res.total_ms, None)
    return png_response(res, limit_headers(v))


@api.post("/v1/remove")
async def v1_remove(request: Request, format: str = "png", owner: db.KeyOwner = Depends(require_key)):
    v = await enforce(f"key:{owner.key_id}", *PLAN_LIMITS.get(owner.plan_tier, PLAN_LIMITS["free"]))
    data = await read_image(request)
    res = await run_cutout(data)
    await db.log_usage("api", res.width * res.height / 1e6, res.total_ms, owner, credits=1)
    if format == "json":
        return JSONResponse({"data": {"result_b64": base64.b64encode(res.png).decode(), "width": res.width,
                                      "height": res.height, "processing_ms": res.total_ms}},
                            headers=limit_headers(v))
    return png_response(res, limit_headers(v))


@api.post("/v1/jobs", status_code=202)
async def v1_jobs_create(request: Request, owner: db.KeyOwner = Depends(require_key)):
    v = await enforce(f"key:{owner.key_id}", *PLAN_LIMITS.get(owner.plan_tier, PLAN_LIMITS["free"]))
    data = await read_image(request)
    r: aioredis.Redis = state["redis"]
    if await r.llen("jobs:queue") >= 50:
        raise HTTPException(503, "Job queue is full. Try again later.", headers={"Retry-After": "30"})
    job_id = uuid.uuid4().hex
    meta = {"id": job_id, "status": "queued", "key_id": owner.key_id, "user_id": owner.user_id}
    async with r.pipeline() as p:
        p.set(f"job:{job_id}:in", data, ex=JOB_TTL)
        p.set(f"job:{job_id}", json.dumps(meta), ex=JOB_TTL)
        p.rpush("jobs:queue", job_id)
        await p.execute()
    return JSONResponse(public_job(meta), 202, headers=limit_headers(v))


def public_job(meta: dict) -> dict:
    out = {k: meta[k] for k in ("id", "status") if k in meta}
    for k in ("width", "height", "processing_ms", "error"):
        if k in meta:
            out[k] = meta[k]
    if meta.get("status") == "done":
        out["result_url"] = f"/v1/jobs/{meta['id']}/result"
    return out


async def load_job(job_id: str, owner: db.KeyOwner) -> dict:
    raw = await state["redis"].get(f"job:{job_id}")
    meta = json.loads(raw) if raw else None
    if not meta or meta.get("key_id") != owner.key_id:
        raise HTTPException(404, "Job not found (jobs expire after 1 hour).")
    return meta


@api.get("/v1/jobs/{job_id}")
async def v1_jobs_get(job_id: str, owner: db.KeyOwner = Depends(require_key)):
    return public_job(await load_job(job_id, owner))


@api.get("/v1/jobs/{job_id}/result")
async def v1_jobs_result(job_id: str, owner: db.KeyOwner = Depends(require_key)):
    meta = await load_job(job_id, owner)
    if meta["status"] != "done":
        raise HTTPException(409, f"Job is {meta['status']}.")
    png = await state["redis"].get(f"job:{job_id}:out")
    if png is None:
        raise HTTPException(404, "Result expired.")
    return Response(png, media_type="image/png", headers={"Cache-Control": "no-store"})


@api.get("/v1/usage")
async def v1_usage(owner: db.KeyOwner = Depends(require_key)):
    per_min, per_day = PLAN_LIMITS.get(owner.plan_tier, PLAN_LIMITS["free"])
    v = await state["limiter"].hit(f"key:{owner.key_id}", per_min, per_day, consume=False)
    total = await db.pool().fetchval("SELECT count(*) FROM usage_logs WHERE api_key_id = $1", owner.key_id)
    return {"plan": owner.plan_tier, "limits": {"per_minute": per_min, "per_day": per_day},
            "remaining": {"minute": v.minute_left, "day": v.day_left}, "total_requests": total}


# ---------------------------------------------------------------- async worker

async def job_worker():
    r: aioredis.Redis = state["redis"]
    while True:
        try:
            item = await r.blpop("jobs:queue", timeout=5)
            if not item:
                continue
            job_id = item[1].decode()
            raw = await r.get(f"job:{job_id}")
            data = await r.get(f"job:{job_id}:in")
            if not raw or data is None:
                continue
            meta = json.loads(raw)
            meta["status"] = "processing"
            await r.set(f"job:{job_id}", json.dumps(meta), ex=JOB_TTL)
            try:
                async with state["compute"]:
                    res = await asyncio.to_thread(state["remover"].remove, data)
                await r.set(f"job:{job_id}:out", res.png, ex=JOB_TTL)
                meta.update(status="done", width=res.width, height=res.height, processing_ms=res.total_ms)
                owner = db.KeyOwner(meta["key_id"], meta["user_id"], "")
                await db.log_usage("api", res.width * res.height / 1e6, res.total_ms, owner, credits=1)
            except BadImage as e:
                meta.update(status="failed", error=str(e))
            await r.delete(f"job:{job_id}:in")
            await r.set(f"job:{job_id}", json.dumps(meta), ex=JOB_TTL)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - keep the worker alive
            log.exception("job worker error")
            await asyncio.sleep(1)


# ---------------------------------------------------------------- static model files

MODELS_DIR = Path(os.getenv("NOBG_MODELS_DIR", "/models"))
_MODEL_NAME = re.compile(r"^/models/([a-z0-9-]+\.bin)$")


class App:
    """Serves /models/*.bin with a fixed `Access-Control-Allow-Origin: *` and an immutable cache header,
    outside the CORS middleware, so Cloudflare can cache a single copy at the edge. Everything else goes to the API."""

    def __init__(self, inner):
        self.inner = inner

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope["path"].startswith("/models/"):
            m = _MODEL_NAME.match(scope["path"])
            f = MODELS_DIR / m.group(1) if m else None
            if scope["method"] not in ("GET", "HEAD") or not f or not f.is_file():
                await PlainTextResponse("not found", 404)(scope, receive, send)
                return
            await FileResponse(f, media_type="application/octet-stream", headers={
                "Cache-Control": "public, max-age=31536000, immutable",
                "Access-Control-Allow-Origin": "*",
            })(scope, receive, send)
            return
        await self.inner(scope, receive, send)


app = App(api)
