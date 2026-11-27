"""Key management CLI. Run inside the api container:

  docker compose exec api python -m app.admin create-key you@example.com [--plan personal] [--label laptop]
  docker compose exec api python -m app.admin list
  docker compose exec api python -m app.admin revoke <key_prefix>
  docker compose exec api python -m app.admin set-plan you@example.com pro
"""
from __future__ import annotations

import argparse
import asyncio

from . import db


async def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m app.admin")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-key"); c.add_argument("email"); c.add_argument("--plan", default=None); c.add_argument("--label")
    sub.add_parser("list")
    r = sub.add_parser("revoke"); r.add_argument("prefix")
    s = sub.add_parser("set-plan"); s.add_argument("email"); s.add_argument("plan", choices=["free", "personal", "pro"])
    a = ap.parse_args()

    pool = await db.init()
    if a.cmd == "create-key":
        uid = await pool.fetchval(
            "INSERT INTO users (email, plan_tier) VALUES ($1, COALESCE($2, 'free')) "
            "ON CONFLICT (email) DO UPDATE SET plan_tier = COALESCE($2, users.plan_tier) RETURNING id",
            a.email.lower(), a.plan)
        raw = db.new_key()
        await pool.execute("INSERT INTO api_keys (user_id, key_hash, key_prefix, label) VALUES ($1, $2, $3, $4)",
                           uid, db.hash_key(raw), raw[:12], a.label)
        print("API key (shown once, store it now):\n\n  " + raw + "\n")
    elif a.cmd == "list":
        rows = await pool.fetch(
            """SELECT u.email, u.plan_tier, k.key_prefix, k.label, k.is_active, k.last_used_at,
                      (SELECT count(*) FROM usage_logs l WHERE l.api_key_id = k.id) AS uses
                 FROM api_keys k JOIN users u ON u.id = k.user_id ORDER BY k.id""")
        for x in rows:
            print(f"{x['key_prefix']}…  {x['email']:<28} {x['plan_tier']:<8} {'active' if x['is_active'] else 'REVOKED':<8} "
                  f"uses={x['uses']:<6} last={x['last_used_at'] or '-'}  {x['label'] or ''}")
    elif a.cmd == "revoke":
        n = await pool.execute("UPDATE api_keys SET is_active = FALSE WHERE key_prefix = $1", a.prefix)
        print(n)
    elif a.cmd == "set-plan":
        print(await pool.execute("UPDATE users SET plan_tier = $2 WHERE email = $1", a.email.lower(), a.plan))
    await db.close()


if __name__ == "__main__":
    asyncio.run(main())
