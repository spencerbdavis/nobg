"""Redis sliding-window rate limits + a process-wide compute semaphore."""
from __future__ import annotations

import asyncio
import os
import time
import uuid
from dataclasses import dataclass

import redis.asyncio as aioredis

PLAN_LIMITS = {  # (per minute, per day)
    "free": (10, 100),
    "personal": (30, 1_000),
    "pro": (60, 10_000),
}
WEB_LIMITS = (int(os.getenv("NOBG_WEB_PER_MIN", "8")), int(os.getenv("NOBG_WEB_PER_DAY", "60")))

MAX_CONCURRENCY = int(os.getenv("NOBG_MAX_CONCURRENCY", "2"))
MAX_WAITING = int(os.getenv("NOBG_MAX_WAITING", "6"))


@dataclass
class Verdict:
    ok: bool
    minute_left: int
    day_left: int
    retry_after: int = 0


_SCRIPT = """
local now = tonumber(ARGV[1])
local member = ARGV[2]
local results = {}
for i = 1, 2 do
  local key = KEYS[i]
  local window = tonumber(ARGV[2 + i * 2 - 1])
  local limit = tonumber(ARGV[2 + i * 2])
  redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
  local n = redis.call('ZCARD', key)
  results[i] = n
  if n >= limit then
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    return {0, i, oldest[2] + window - now, results[1], 0}
  end
end
for i = 1, 2 do
  redis.call('ZADD', KEYS[i], now, member)
  redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[2 + i * 2 - 1]))
end
return {1, 0, 0, results[1] + 1, results[2] + 1}
"""


class Limiter:
    def __init__(self, r: aioredis.Redis):
        self.r = r
        self._script = r.register_script(_SCRIPT)

    async def hit(self, ident: str, per_min: int, per_day: int, consume: bool = True) -> Verdict:
        now = int(time.time() * 1000)
        keys = [f"rl:{ident}:m", f"rl:{ident}:d"]
        if not consume:
            await self.r.zremrangebyscore(keys[0], 0, now - 60_000)
            await self.r.zremrangebyscore(keys[1], 0, now - 86_400_000)
            m, d = await self.r.zcard(keys[0]), await self.r.zcard(keys[1])
            return Verdict(True, max(0, per_min - m), max(0, per_day - d))
        ok, which, wait_ms, m, d = await self._script(
            keys=keys, args=[now, uuid.uuid4().hex, 60_000, per_min, 86_400_000, per_day]
        )
        if not ok:
            return Verdict(False, max(0, per_min - int(m)), 0 if int(which) == 2 else -1, max(1, int(wait_ms) // 1000 + 1))
        return Verdict(True, per_min - int(m), per_day - int(d))


class Compute:
    """At most MAX_CONCURRENCY inferences at once; refuse beyond MAX_WAITING queued."""

    def __init__(self) -> None:
        self.sem = asyncio.Semaphore(MAX_CONCURRENCY)
        self.waiting = 0

    @property
    def busy(self) -> bool:
        return self.waiting >= MAX_WAITING

    async def __aenter__(self):
        self.waiting += 1
        try:
            await self.sem.acquire()
        finally:
            self.waiting -= 1
        return self

    async def __aexit__(self, *exc):
        self.sem.release()
