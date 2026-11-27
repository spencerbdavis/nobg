#!/usr/bin/env bash
# Sync the server side to ubuntu2 and (re)start it. Usage: ./deploy.sh [--public]
set -euo pipefail
HOST="${NOBG_HOST:-spencer@ubuntu2}"; DIR="${NOBG_DIR:-nobg}"
cd "$(dirname "$0")"
rsync -az --delete --exclude __pycache__ server db tools docker-compose.yml fetch-models.sh smoke.sh .env.example .dockerignore "$HOST:$DIR/"
ssh "$HOST" bash -s -- "$DIR" "${1:-none}" <<'REMOTE'
set -euo pipefail
cd "$1"
mkdir -p data/postgres
[ -f .env ] || { cp .env.example .env; sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env; chmod 600 .env; echo "created .env"; }
./fetch-models.sh
profile=""; [ "$2" = "--public" ] && profile="--profile public"
docker compose $profile up -d --build --remove-orphans
docker image prune -f >/dev/null
docker compose ps
REMOTE
