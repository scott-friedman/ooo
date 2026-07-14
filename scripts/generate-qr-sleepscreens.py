#!/usr/bin/env python3
"""Generate artistic-but-scannable QR sleep screens for the Xteink X3.

The X3 is a pure 1-bit black/white e-ink reader (528x792 portrait). Sleep
screens are 24-bit uncompressed BMPs; with CrossPoint firmware, drop them in a
`sleep/` folder at the storage root and set Sleep Screen -> Custom.

All variants encode the same URL (default https://scottfriedman.ooo/x) at
error-correction level H. Module centers and function patterns (finder eyes,
timing, alignment, format info) are always rendered faithfully; artwork only
occupies pixels a decoder doesn't sample. Every output is decode-verified with
zxing-cpp at full and half resolution before the script exits 0.

Usage:
  python3 generate-qr-sleepscreens.py --out DIR [--landscape] [--bias 0.35]
                                      [--url URL] [--seed N]

Deps (throwaway venv is fine): pip install qrcode pillow numpy zxing-cpp
"""

import argparse
import math
import random
import sys
from pathlib import Path

import numpy as np
import qrcode
from PIL import Image, ImageDraw, ImageFont

DEFAULT_URL = "https://scottfriedman.ooo/x"
PORTRAIT = (528, 792)  # X3 panel, portrait
QUIET = 4  # quiet-zone width in modules (spec minimum)

# Alignment-pattern center coordinates per QR version (enough for short URLs).
ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 52],
}

BAYER8 = np.array([
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
]) / 64.0


def build_qr(url):
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_H, border=0)
    qr.add_data(url)
    qr.make(fit=True)
    matrix = [[bool(v) for v in row] for row in qr.modules]
    return matrix, qr.version


def function_mask(n, version):
    """True for modules a decoder samples structurally (must stay solid)."""
    mask = [[False] * n for _ in range(n)]

    def mark(r0, c0, h, w):
        for r in range(max(r0, 0), min(r0 + h, n)):
            for c in range(max(c0, 0), min(c0 + w, n)):
                mask[r][c] = True

    mark(0, 0, 9, 9)          # finder + separator + format info, top-left
    mark(0, n - 8, 9, 8)      # top-right
    mark(n - 8, 0, 8, 9)      # bottom-left (includes dark module)
    for i in range(n):        # timing patterns
        mask[6][i] = mask[i][6] = True
    for r in ALIGN.get(version, []):
        for c in ALIGN.get(version, []):
            if (r < 9 and c < 9) or (r < 9 and c > n - 9) or (r > n - 9 and c < 9):
                continue      # would overlap a finder; spec omits these
            mark(r - 2, c - 2, 5, 5)
    if version >= 7:          # version info blocks
        mark(0, n - 11, 6, 3)
        mark(n - 11, 0, 3, 6)
    return mask


def art_field(W, H):
    """Abstract interference field in [0,1] (1 = white)."""
    y, x = np.mgrid[0:H, 0:W].astype(float)
    v = (
        np.sin(x * 0.020 + y * 0.008)
        + np.sin(np.hypot(x - W * 0.30, y - H * 0.22) * 0.030)
        + np.sin(np.hypot(x - W * 0.85, y - H * 0.88) * 0.017)
        + 0.6 * np.sin(y * 0.013 - x * 0.007)
    )
    return (v - v.min()) / (v.max() - v.min())


def stripe_field(W, H):
    """Bold binary interference bands (~1.5 modules wide), 1.0 = white."""
    y, x = np.mgrid[0:H, 0:W].astype(float)
    v = (
        np.sin(x * 0.11 + 6.0 * np.sin(y * 0.018))
        + 0.7 * np.sin(np.hypot(x - W * 0.75, y - H * 0.12) * 0.09)
    )
    return (v > 0).astype(float)


def bayer_dither(field):
    """Ordered-dither a [0,1] float field to a binary uint8 array (0/255)."""
    H, W = field.shape
    thresh = np.tile(BAYER8, (H // 8 + 1, W // 8 + 1))[:H, :W]
    return np.where(field > thresh, 255, 0).astype(np.uint8)


def qr_geometry(canvas, n, subcell):
    """Center the QR on the canvas; returns (x0, y0, module_px)."""
    W, H = canvas
    m = subcell * 3
    side = n * m
    if side + 2 * QUIET * m > min(W, H):
        raise SystemExit(f"QR ({n} modules) too large for canvas at {m}px/module")
    return (W - side) // 2, (H - side) // 2, m


def to_bmp_image(binary_array):
    return Image.fromarray(binary_array, mode="L").convert("RGB")


def finalize(img_l, threshold=128):
    """Threshold a grayscale PIL image to pure black/white RGB."""
    return img_l.point(lambda p: 255 if p >= threshold else 0).convert("RGB")


# ---------------------------------------------------------------- renderers

def render_plain(canvas, matrix, fmask, bias):
    W, H = canvas
    n = len(matrix)
    x0, y0, m = qr_geometry(canvas, n, subcell=4)
    arr = np.full((H, W), 255, np.uint8)
    for r in range(n):
        for c in range(n):
            if matrix[r][c]:
                arr[y0 + r * m:y0 + (r + 1) * m, x0 + c * m:x0 + (c + 1) * m] = 0
    return to_bmp_image(arr)


def render_halftone(canvas, matrix, fmask, bias):
    """Bold wave bands flow across the whole canvas and straight through the
    QR's data modules; each module's authoritative color lives in a pinned
    square at its center (the point decoders sample). `bias` grows that pin:
    0 -> 1/3 of the module, 1 -> the whole module (i.e., a plain QR)."""
    W, H = canvas
    n = len(matrix)
    x0, y0, m = qr_geometry(canvas, n, subcell=4)
    sub = m // 3
    pin = int(np.clip(round(sub * (1 + 2 * bias)), sub, m))
    q = QUIET * m

    art = stripe_field(W, H)
    field = art.copy()
    # Quiet zone (and QR area, restored per-module below): pure white.
    field[y0 - q:y0 + n * m + q, x0 - q:x0 + n * m + q] = 1.0
    for r in range(n):
        for c in range(n):
            mod = 0.0 if matrix[r][c] else 1.0
            ry, rx = y0 + r * m, x0 + c * m
            if fmask[r][c]:
                field[ry:ry + m, rx:rx + m] = mod
                continue
            # Data module: art fills the module, pinned center stays exact.
            field[ry:ry + m, rx:rx + m] = art[ry:ry + m, rx:rx + m]
            o = (m - pin) // 2
            field[ry + o:ry + o + pin, rx + o:rx + o + pin] = mod
    return to_bmp_image((field * 255).astype(np.uint8))


def render_maze(canvas, matrix, fmask, bias, seed):
    """Dark modules as connected ink blobs; ring finder eyes; dot texture."""
    W, H = canvas
    n = len(matrix)
    x0, y0, m = qr_geometry(canvas, n, subcell=4)
    q = QUIET * m
    S = 3  # supersampling factor
    img = Image.new("L", (W * S, H * S), 255)
    d = ImageDraw.Draw(img)
    rng = random.Random(seed)

    def mc(r, c):  # module center in supersampled px
        return ((x0 + (c + 0.5) * m) * S, (y0 + (r + 0.5) * m) * S)

    finders = {(0, 0), (0, n - 7), (n - 7, 0)}

    def in_finder(r, c):
        return any(fr <= r < fr + 7 and fc <= c < fc + 7 for fr, fc in finders)

    # Background: sparse dots along wavy contour lines, outside the quiet zone.
    qz = (x0 - q, y0 - q, x0 + n * m + q, y0 + n * m + q)
    for row in range(10, H, 14):
        phase = rng.uniform(0, math.tau)
        for col in range(6, W, 9):
            yy = row + 5 * math.sin(col * 0.045 + phase)
            if qz[0] - 6 < col < qz[2] + 6 and qz[1] - 6 < yy < qz[3] + 6:
                continue
            rad = (1.1 + 0.9 * math.sin(col * 0.02 + row * 0.03 + phase)) * S
            if rad > 0.4 * S:
                d.ellipse([col * S - rad, yy * S - rad, col * S + rad, yy * S + rad], fill=0)

    # Data + non-finder function modules as blobs with bridges.
    br = 0.72 * m * S / 2  # bridge half-width
    for r in range(n):
        for c in range(n):
            if not matrix[r][c] or in_finder(r, c):
                continue
            cx, cy = mc(r, c)
            rad = 0.54 * m * S * (1 + rng.uniform(-0.05, 0.05))
            d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=0)
            for dr, dc in ((0, 1), (1, 0)):
                rr, cc = r + dr, c + dc
                if rr < n and cc < n and matrix[rr][cc] and not in_finder(rr, cc):
                    nx, ny = mc(rr, cc)
                    if dr:
                        d.rectangle([cx - br, cy, cx + br, ny], fill=0)
                    else:
                        d.rectangle([cx, cy - br, nx, cy + br], fill=0)

    # Finder eyes as concentric rings (outer ring 1 module thick, 3-module core).
    for fr, fc in finders:
        cx = (x0 + (fc + 3.5) * m) * S
        cy = (y0 + (fr + 3.5) * m) * S
        for rad, fill in ((3.5 * m * S, 0), (2.5 * m * S, 255), (1.5 * m * S, 0)):
            d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=fill)

    img = img.resize((W, H), Image.LANCZOS)
    return finalize(img)


def render_framed(canvas, matrix, fmask, bias):
    """The QR as a framed print hanging on a textured wall."""
    W, H = canvas
    n = len(matrix)
    x0, y0, m = qr_geometry(canvas, n, subcell=3)  # smaller QR so the frame gets wall around it
    q = QUIET * m

    # Airy wall texture (art remapped toward white so the frame dominates).
    wall = bayer_dither(0.72 + 0.28 * art_field(W, H))
    img = Image.fromarray(wall, "L")
    d = ImageDraw.Draw(img)

    side = n * m
    mat = (x0 - q, y0 - q, x0 + side + q, y0 + side + q)
    frame = tuple(v + off for v, off in zip(mat, (-14, -14, 14, 14)))
    outer = tuple(v + off for v, off in zip(mat, (-20, -20, 20, 20)))

    # Hanging wire up to a nail near the top.
    nail_y = max(26, frame[1] - 90)
    d.line([frame[0] + 24, frame[1], W // 2, nail_y], fill=0, width=2)
    d.line([frame[2] - 24, frame[1], W // 2, nail_y], fill=0, width=2)
    d.ellipse([W // 2 - 5, nail_y - 5, W // 2 + 5, nail_y + 5], fill=0)

    d.rectangle(outer, outline=0, width=3)   # thin outer frame line
    d.rectangle(frame, fill=0)               # frame body
    d.rectangle(mat, fill=255)               # white mat = quiet zone

    for r in range(n):
        for c in range(n):
            if matrix[r][c]:
                d.rectangle(
                    [x0 + c * m, y0 + r * m, x0 + (c + 1) * m - 1, y0 + (r + 1) * m - 1],
                    fill=0,
                )

    # Caption plaque under the frame.
    caption = "scottfriedman.ooo/x"
    try:
        font = ImageFont.load_default(size=17)
    except TypeError:  # older Pillow
        font = ImageFont.load_default()
    tb = d.textbbox((0, 0), caption, font=font)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    px, py = (W - tw) // 2, outer[3] + 26
    d.rectangle([px - 12, py - 8, px + tw + 12, py + th + 10], fill=255, outline=0, width=2)
    d.text((px, py - tb[1] + 1), caption, fill=0, font=font)
    return finalize(img)


# ------------------------------------------------------------- verification

def verify(img, url, name):
    import zxingcpp

    for scale, label in ((1.0, "full"), (0.5, "half")):
        probe = img if scale == 1.0 else img.resize(
            (int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
        results = zxingcpp.read_barcodes(probe)
        texts = [r.text for r in results]
        if url not in texts:
            raise SystemExit(f"FAIL {name} ({label}-res): decoded {texts or 'nothing'}")
    print(f"  decode OK ({name})")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, required=True, help="output directory")
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--landscape", action="store_true", help="emit 792x528 instead of 528x792")
    ap.add_argument("--bias", type=float, default=0.25,
                    help="halftone pinned-center size, 0..1 (higher = safer to scan, plainer art)")
    ap.add_argument("--seed", type=int, default=3, help="jitter seed for the maze variant")
    args = ap.parse_args()

    canvas = PORTRAIT[::-1] if args.landscape else PORTRAIT
    matrix, version = build_qr(args.url)
    n = len(matrix)
    fmask = function_mask(n, version)
    print(f"QR: version {version} ({n}x{n} modules), EC level H, url={args.url}")

    args.out.mkdir(parents=True, exist_ok=True)
    variants = {
        "halftone": lambda: render_halftone(canvas, matrix, fmask, args.bias),
        "maze": lambda: render_maze(canvas, matrix, fmask, args.bias, args.seed),
        "framed": lambda: render_framed(canvas, matrix, fmask, args.bias),
        "plain": lambda: render_plain(canvas, matrix, fmask, args.bias),
    }
    for name, render in variants.items():
        img = render()
        verify(img, args.url, name)
        img.save(args.out / f"qr-{name}.bmp")          # 24-bit BMP for the X3
        img.save(args.out / f"qr-{name}-preview.png")  # convenience preview
    print(f"Wrote {len(variants)} BMPs (+previews) to {args.out}/ — copy *.bmp to the X3")


if __name__ == "__main__":
    sys.exit(main())
