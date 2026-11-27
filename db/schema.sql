-- nobg schema. Applied automatically by the api container on startup (idempotent).
-- Works on local Postgres or a managed one (Neon / Supabase) via DATABASE_URL.

CREATE TABLE IF NOT EXISTS users (
    id             BIGSERIAL PRIMARY KEY,
    email          TEXT NOT NULL UNIQUE,
    plan_tier      TEXT NOT NULL DEFAULT 'free' CHECK (plan_tier IN ('free', 'personal', 'pro')),
    credit_balance INTEGER NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_hash     TEXT NOT NULL UNIQUE,          -- sha256 hex of the full raw key
    key_prefix   TEXT NOT NULL,                 -- first 12 chars, for display only
    label        TEXT,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS usage_logs (
    id            BIGSERIAL PRIMARY KEY,
    user_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
    api_key_id    BIGINT REFERENCES api_keys(id) ON DELETE SET NULL,
    source        TEXT NOT NULL CHECK (source IN ('web_fallback', 'api')),
    resolution_mp REAL NOT NULL,
    processing_ms INTEGER NOT NULL,
    credits_cost  INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS usage_logs_key_time ON usage_logs (api_key_id, created_at);
