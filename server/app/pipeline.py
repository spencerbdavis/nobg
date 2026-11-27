"""Image -> transparent PNG. Pure functions, no I/O beyond bytes in / bytes out.

Steps: decode (EXIF-aware) -> ISNet matte at 1024 -> bilinear upscale of the
matte to full resolution -> blur-fusion foreground estimation (strips
background colour spill from hair and soft edges) -> RGBA PNG.
"""
from __future__ import annotations

import io
import os
import time
from dataclasses import dataclass

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 60_000_000  # decompression-bomb guard

MODEL_SIZE = 1024
MAX_PIXELS = int(float(os.getenv("NOBG_MAX_MP", "16")) * 1_000_000)


class BadImage(ValueError):
    pass


@dataclass
class Result:
    png: bytes
    width: int
    height: int
    infer_ms: int
    total_ms: int


class Remover:
    def __init__(self, model_path: str, threads: int = 4):
        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        so.enable_cpu_mem_arena = False  # return memory to the OS between jobs
        self.session = ort.InferenceSession(model_path, so, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name

    def matte(self, rgb: np.ndarray) -> np.ndarray:
        """rgb uint8 HxWx3 -> float32 alpha 1024x1024 in [0,1]."""
        x = cv2.resize(rgb, (MODEL_SIZE, MODEL_SIZE), interpolation=cv2.INTER_AREA).astype(np.float32)
        x = x / max(float(x.max()), 1e-6) - 0.5  # ISNet normalisation: mean .5, std 1
        x = x.transpose(2, 0, 1)[None]
        pred = self.session.run(None, {self.input_name: x})[0][0, 0]
        lo, hi = float(pred.min()), float(pred.max())
        return np.clip((pred - lo) / max(hi - lo, 1e-6), 0.0, 1.0).astype(np.float32)

    def warmup(self) -> None:
        self.matte(np.zeros((64, 64, 3), np.uint8))

    def remove(self, data: bytes) -> Result:
        t0 = time.perf_counter()
        rgb = decode(data)
        t1 = time.perf_counter()
        small = self.matte(rgb)
        t2 = time.perf_counter()
        h, w = rgb.shape[:2]
        alpha = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
        fg = estimate_foreground(rgb, alpha)
        rgba = np.dstack([fg, np.round(alpha * 255).astype(np.uint8)])
        buf = io.BytesIO()
        Image.fromarray(rgba, "RGBA").save(buf, "PNG", compress_level=6)
        t3 = time.perf_counter()
        return Result(buf.getvalue(), w, h, int((t2 - t1) * 1000), int((t3 - t0) * 1000))


def decode(data: bytes) -> np.ndarray:
    try:
        im = Image.open(io.BytesIO(data))
        im.draft("RGB", (8192, 8192))  # cheap JPEG downscale for huge inputs
        im = ImageOps.exif_transpose(im)
        if im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
            im = Image.alpha_composite(bg, im)
        im = im.convert("RGB")
    except Exception as e:  # noqa: BLE001 - any decoder failure is the caller's bad input
        raise BadImage("Could not read that image. Try JPG, PNG or WebP.") from e
    if im.width * im.height > MAX_PIXELS:
        s = (MAX_PIXELS / (im.width * im.height)) ** 0.5
        im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.LANCZOS)
    return np.asarray(im)


def _blur_fusion(img, fg, bg, alpha, r):
    blurred_alpha = cv2.blur(alpha, (r, r))[..., None]
    blurred_fga = cv2.blur(fg * alpha[..., None], (r, r))
    blurred_fg = blurred_fga / (blurred_alpha + 1e-5)
    blurred_bga = cv2.blur(bg * (1 - alpha[..., None]), (r, r))
    blurred_bg = blurred_bga / ((1 - blurred_alpha) + 1e-5)
    a = alpha[..., None]
    fg = blurred_fg + a * (img - a * blurred_fg - (1 - a) * blurred_bg)
    return np.clip(fg, 0, 1), blurred_bg


def estimate_foreground(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Approximate Fast Multi-Level Foreground Estimation (blur fusion, 2 passes)."""
    img = rgb.astype(np.float32) / 255.0
    scale = max(img.shape[:2]) / 1024
    r1, r2 = max(3, int(90 * scale)), max(3, int(6 * scale))
    fg, bg = _blur_fusion(img, img, img, alpha, r1)
    fg, _ = _blur_fusion(img, fg, bg, alpha, r2)
    return np.round(fg * 255).astype(np.uint8)
