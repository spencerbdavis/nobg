#!/usr/bin/env bash
# Run on ubuntu2 in ~/nobg: cut out an image through the private edge network. Usage: ./smoke.sh photo.jpg [out.png]
set -euo pipefail
in="$(realpath "$1")"; out="${2:-/tmp/nobg-smoke.png}"
docker run --rm --network nobg_edge -v "$in:/in.jpg:ro" curlimages/curl:8.17.0 \
  -sS -F image_file=@/in.jpg -D /dev/stderr -o - http://nobg-api:8000/web/remove > "$out"
echo "wrote $out"
