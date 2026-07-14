#!/usr/bin/env python3
"""Generate AI QR art for the Xteink X3: paintings that scan as QR codes.

Uses Stable Diffusion 1.5 (DreamShaper 8) + the "QR Code Monster" v2
ControlNet (monster-labs/control_v1p_sd15_qrcode_monster) to paint imagery
whose light/dark structure doubles as a QR code, then applies the e-ink
treatment (grayscale -> 528px -> 1-bit Floyd-Steinberg dither) and keeps only
candidates that still machine-decode under a camera-realistic sweep
(gaussian blur x downscale, mimicking a phone photographing a ~5cm screen).

Survivors are written as X3-ready 528x792 24-bit BMPs plus color previews.

Runs fully locally (Apple Silicon MPS). First run downloads ~5GB of model
weights to the Hugging Face cache. ~30-60s per candidate on an M3.

Deps: pip install torch diffusers transformers accelerate safetensors \
                  qrcode pillow numpy zxing-cpp
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import qrcode
from PIL import Image, ImageFilter, ImageOps

DEFAULT_URL = "https://scottfriedman.ooo/x"
X3_PORTRAIT = (528, 792)
GEN_SIZE = (512, 768)  # SD1.5-native portrait; upscaled to X3 at the end

# High-contrast styles chosen to survive 1-bit dithering on e-ink.
THEMES = {
    "woodcut-mountains": (
        "black and white woodcut print of a dramatic mountain landscape with pine forest, "
        "bold carved lines, high contrast, traditional ukiyo-e style, masterpiece"
    ),
    "ink-waves": (
        "black ink wash painting of crashing ocean waves, sumi-e style, "
        "swirling foam, high contrast, dramatic, masterpiece"
    ),
    "etched-city": (
        "detailed pen and ink etching of a dense medieval city with towers and rooftops, "
        "crosshatching, engraving style, high contrast, masterpiece"
    ),
    "linocut-forest": (
        "black and white linocut print of a dense forest with a winding path and rays of light, "
        "bold shapes, high contrast, masterpiece"
    ),
    "boston-skyline": (
        "black and white woodcut print of the Boston city skyline at night with dramatic clouds, "
        "bold carved lines, high contrast, masterpiece"
    ),
    "moon-craters": (
        "high contrast black and white illustration of a cratered moon surface with stars, "
        "stippling and ink, dramatic shadows, masterpiece"
    ),
}
NEGATIVE = "low contrast, gray, hazy, blurry, photo, ugly, text, watermark, frame, border"


def control_image(url, border):
    """Standard QR as the ControlNet conditioning image, centered on a white
    portrait canvas so the art can bleed to the edges around it."""
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, border=border)
    qr.add_data(url)
    qr.make(fit=True)
    n = len(qr.modules) + 2 * border
    box = max(1, GEN_SIZE[0] // n)
    img = qr.make_image(fill_color="black", back_color="white").get_image()
    img = img.resize((n * box, n * box), Image.NEAREST)
    canvas = Image.new("RGB", GEN_SIZE, "white")
    canvas.paste(img, ((GEN_SIZE[0] - img.width) // 2, (GEN_SIZE[1] - img.height) // 2))
    return canvas


def eink_treatment(img):
    """What the X3 does to a picture: grayscale, 528px, pure 1-bit dither."""
    g = ImageOps.autocontrast(img.convert("L"))
    w, h = X3_PORTRAIT
    scale = max(w / g.width, h / g.height)
    g = g.resize((round(g.width * scale), round(g.height * scale)), Image.LANCZOS)
    g = g.crop(((g.width - w) // 2, (g.height - h) // 2,
                (g.width - w) // 2 + w, (g.height - h) // 2 + h))
    return g.convert("1").convert("L")


def decode_score(img, url):
    """How many camera-realistic (blur, scale) probes decode. 0 = reject."""
    import zxingcpp

    hits = 0
    for blur in (0, 1, 1.5, 2, 3):
        for scale in (1.0, 0.75, 0.5):
            probe = img.convert("L")
            if blur:
                probe = probe.filter(ImageFilter.GaussianBlur(blur))
            if scale != 1.0:
                probe = probe.resize(
                    (max(1, int(probe.width * scale)), max(1, int(probe.height * scale))),
                    Image.LANCZOS)
            found = zxingcpp.read_barcodes(probe, try_rotate=True, try_downscale=True)
            if found and any(r.text == url for r in found):
                hits += 1
    return hits


def build_pipeline(fp32=False):
    import torch
    from diffusers import (ControlNetModel, StableDiffusionControlNetPipeline,
                           UniPCMultistepScheduler)

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    # fp16 on MPS intermittently NaNs out to all-black images; fp32 is the
    # reliable-but-slower fallback (see is_black() guard in main()).
    dtype = torch.float32 if (fp32 or device == "cpu") else torch.float16
    controlnet = ControlNetModel.from_pretrained(
        "monster-labs/control_v1p_sd15_qrcode_monster", subfolder="v2", torch_dtype=dtype)
    pipe = StableDiffusionControlNetPipeline.from_pretrained(
        "Lykon/dreamshaper-8", controlnet=controlnet,
        torch_dtype=dtype, safety_checker=None, requires_safety_checker=False)
    pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config)
    return pipe.to(device)


def is_black(img):
    """Detect the MPS fp16 NaN failure mode (an all-black frame)."""
    return np.asarray(img.convert("L")).max() < 10


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--themes", nargs="*", default=list(THEMES),
                    help=f"subset of: {', '.join(THEMES)}")
    ap.add_argument("--seeds", type=int, nargs="*", default=[7, 42, 1337, 2026])
    ap.add_argument("--scales", type=float, nargs="*", default=[1.3, 1.5],
                    help="controlnet conditioning scales (higher = more scannable, less arty)")
    ap.add_argument("--steps", type=int, default=28)
    ap.add_argument("--border", type=int, default=3, help="QR quiet zone in control image")
    ap.add_argument("--min-hits", type=int, default=2,
                    help="decode probes that must succeed to keep a candidate")
    ap.add_argument("--fp32", action="store_true",
                    help="run in float32 from the start (slower, immune to MPS NaN)")
    args = ap.parse_args()

    import torch

    args.out.mkdir(parents=True, exist_ok=True)
    cond = control_image(args.url, args.border)
    cond.save(args.out / "_control.png")
    pipe = build_pipeline(fp32=args.fp32)
    fp32_mode = args.fp32

    def generate(prompt, scale, seed):
        gen = torch.Generator("cpu").manual_seed(seed)
        return pipe(prompt, negative_prompt=NEGATIVE, image=cond,
                    num_inference_steps=args.steps, guidance_scale=7.0,
                    controlnet_conditioning_scale=scale, generator=gen).images[0]

    total = len(args.themes) * len(args.seeds) * len(args.scales)
    done = kept = 0
    for theme in args.themes:
        prompt = THEMES[theme]
        for scale in args.scales:
            for seed in args.seeds:
                done += 1
                img = generate(prompt, scale, seed)
                if is_black(img) and not fp32_mode:
                    # fp16 NaN'd out; rebuild in fp32 for the rest of the run.
                    print(f"[{done}/{total}] black frame from fp16 - switching to fp32", flush=True)
                    pipe = build_pipeline(fp32=True)
                    fp32_mode = True
                    img = generate(prompt, scale, seed)
                if is_black(img):
                    print(f"[{done}/{total}] {theme}-cs{scale}-s{seed}: BLACK even in fp32, skipping", flush=True)
                    continue
                eink = eink_treatment(img)
                hits = decode_score(eink, args.url)
                tag = f"{theme}-cs{scale}-s{seed}"
                if hits >= args.min_hits:
                    kept += 1
                    img.save(args.out / f"keep-{tag}-color.png")
                    eink.save(args.out / f"keep-{tag}-eink.png")
                    eink.convert("RGB").save(args.out / f"keep-{tag}.bmp")
                    verdict = f"KEEP (hits={hits})"
                else:
                    img.save(args.out / f"reject-{tag}-color.png")
                    verdict = f"reject (hits={hits})"
                print(f"[{done}/{total}] {tag}: {verdict}", flush=True)
    print(f"\n{kept}/{total} candidates survived the decode gate -> {args.out}/keep-*.bmp")
    return 0 if kept else 1


if __name__ == "__main__":
    sys.exit(main())
