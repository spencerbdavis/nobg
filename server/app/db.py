from __future__ import annotations

import hashlib
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

import asyncpg

KEY_PREFIX = "bg_live_"
_pool: asyncpg.Pool | None = None


@dataclass
class KeyOwner:
    key_id: int
    user_id: int
    plan_tier: str


def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def new_key() -> str:
    return KEY_PREFIX + secrets.token_urlsafe(32)


async def init() -> asyncpg.Pool:
    global _pool
    _pool = await asyncpg.create_pool(os.environ["DATABASE_URL"], min_size=1, max_size=4)
    schema = Path(os.getenv("NOBG_SCHEMA", "/app/schema.sql")).read_text()
    async with _pool.acquire() as c:
        await c.execute(schema)
    return _pool


async def close() -> None:
    if _pool:
        await _pool.close()


def pool() -> asyncpg.Pool:
    assert _pool is not None, "db.init() not called"
    return _pool


async def lookup_key(raw: str) -> KeyOwner | None:
    if not raw.startswith(KEY_PREFIX):
        return None
    row = await pool().fetchrow(
        """UPDATE api_keys k SET last_used_at = now()
             FROM users u
            WHERE k.key_hash = $1 AND k.is_active AND u.id = k.user_id
        RETURNING k.id, k.user_id, u.plan_tier""",
        hash_key(raw),
    )
    return KeyOwner(row["id"], row["user_id"], row["plan_tier"]) if row else None


async def log_usage(source: str, mp: float, ms: int, owner: KeyOwner | None, credits: int = 0) -> None:
    await pool().execute(
        """INSERT INTO usage_logs (user_id, api_key_id, source, resolution_mp, processing_ms, credits_cost)
           VALUES ($1, $2, $3, $4, $5, $6)""",
        owner.user_id if owner else None,
        owner.key_id if owner else None,
        source,
        round(mp, 2),
        ms,
        credits,
    )
