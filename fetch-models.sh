#!/usr/bin/env bash
# Prepares ./models (not committed):
#   isnet_general.onnx        server model, ISNet-general (Apache-2.0) from the rembg releases
#   isnet-fp16-<hash>.bin     browser model, built from it (fp16, main output only)
#   modnet-fp16-<hash>.bin    browser quick-preview model, MODNet portrait matting (Apache-2.0)
set -euo pipefail
cd "$(dirname "$0")"; mkdir -p models
SERVER_SHA=60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a
WEB_SHA=281bde9eb4397ec3310b1afa0c1022a8fbdabca3bb4dccdfb6da2c44b5ea8b90
MODNET_SHA=25f165da9bfd30830a575f1f0490f1acd995975cb349bc02f3d79332e1fe5cf6
MODNET_REV=fa2fa546052fba4c08921230a26cc69a333fca12   # huggingface.co/Xenova/modnet, pinned
sha() { (command -v sha256sum >/dev/null && sha256sum "$1" || shasum -a 256 "$1") | cut -d' ' -f1; }

f=models/isnet_general.onnx
if [ ! -s "$f" ]; then
  curl -fL --retry 3 -o "$f.part" https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx
  mv "$f.part" "$f"
fi
[ "$(sha "$f")" = "$SERVER_SHA" ] || { echo "checksum mismatch: $f" >&2; exit 1; }

w="models/isnet-fp16-${WEB_SHA:0:8}.bin"
if [ ! -s "$w" ]; then
  docker run --rm --network bridge -v "$PWD/models:/models" -v "$PWD/tools:/tools:ro" python:3.12-slim sh -c \
    "pip -q install --root-user-action=ignore onnx==1.23.2 onnxconverter-common==1.16.0 protobuf==7.36.2 numpy==2.5.5 2>/dev/null &&
     python -W ignore /tools/make_web_model.py /models/isnet_general.onnx /models/web.part && chown $(id -u):$(id -g) /models/web.part"
  mv models/web.part "$w"
fi
[ "$(sha "$w")" = "$WEB_SHA" ] || { echo "checksum mismatch: $w (converter output changed?)" >&2; exit 1; }
m="models/modnet-fp16-${MODNET_SHA:0:8}.bin"
if [ ! -s "$m" ]; then
  curl -fL --retry 3 -o "$m.part" "https://huggingface.co/Xenova/modnet/resolve/$MODNET_REV/onnx/model_fp16.onnx"
  mv "$m.part" "$m"
fi
[ "$(sha "$m")" = "$MODNET_SHA" ] || { echo "checksum mismatch: $m" >&2; exit 1; }
echo "models ok"
