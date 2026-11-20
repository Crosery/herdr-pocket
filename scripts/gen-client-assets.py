#!/usr/bin/env python3
"""Generate branded client icons, Windows NSIS/WiX bitmaps, macOS Retina DMG art, and HarmonyOS assets."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BRAND_DIR = ROOT / "docs" / "brand"
DESKTOP_RES = ROOT / "apps" / "desktop" / "src-tauri"
ICONS_DIR = DESKTOP_RES / "icons"
WIN_DIR = DESKTOP_RES / "windows"
DMG_DIR = DESKTOP_RES / "dmg"
HARMONY_APP_MEDIA = ROOT / "apps" / "harmony" / "AppScope" / "resources" / "base" / "media"
HARMONY_ENTRY_MEDIA = ROOT / "apps" / "harmony" / "entry" / "src" / "main" / "resources" / "base" / "media"


def load_font(size: int, *, bold: bool = False, cjk: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates: list[str] = []
    if cjk:
        candidates.extend([
            "/System/Library/Fonts/STHeiti Medium.ttc" if bold else "/System/Library/Fonts/STHeiti Light.ttc",
            "/System/Library/Fonts/Hiragino Sans GB.ttc",
            "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        ])
    else:
        candidates.extend([
            "/System/Library/Fonts/SFNSRounded.ttf",
            "/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf" if bold else "/System/Library/Fonts/HelveticaNeue.ttc",
            "/System/Library/Fonts/SFNS.ttf",
        ])
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def superellipse_mask(size: int, radius: float, scale: int = 4) -> Image.Image:
    """Create a smooth rounded-square alpha mask at `size x size` via supersampling."""
    hi = size * scale
    mask = Image.new("L", (hi, hi), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([0, 0, hi - 1, hi - 1], radius=radius * scale, fill=255)
    return mask.resize((size, size), Image.Resampling.LANCZOS)


def make_squircle_icon(
    src: Image.Image,
    canvas_size: int,
    inner_size: int,
    corner_ratio: float = 0.225,
    *,
    with_shadow: bool = False,
) -> Image.Image:
    """Place `src` inside a continuous rounded square centered in `canvas_size` RGBA."""
    res = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    scaled = src.convert("RGBA").resize((inner_size, inner_size), Image.Resampling.LANCZOS)
    mask = superellipse_mask(inner_size, inner_size * corner_ratio)
    offset = (canvas_size - inner_size) // 2

    if with_shadow:
        shadow_canvas = Image.new("RGBA", (canvas_size, canvas_size), (62, 24, 48, 0))
        shadow_shape = Image.new("RGBA", (inner_size, inner_size), (62, 24, 48, 64))
        shadow_shape.putalpha(
            mask.point(lambda a: int(a * 0.28))
        )
        dy = max(2, int(round(canvas_size * 0.012)))
        shadow_canvas.paste(shadow_shape, (offset, offset + dy), shadow_shape)
        blur = max(2.0, canvas_size * 0.022)
        shadow_canvas = shadow_canvas.filter(ImageFilter.GaussianBlur(blur))
        res = Image.alpha_composite(res, shadow_canvas)

    fg = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    fg.paste(scaled, (offset, offset), mask)
    return Image.alpha_composite(res, fg)


def vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], mid: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    w, h = size
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / max(1, h - 1)
        if t < 0.5:
            u = t * 2.0
            c = tuple(int(round(top[i] + (mid[i] - top[i]) * u)) for i in range(3))
        else:
            u = (t - 0.5) * 2.0
            c = tuple(int(round(mid[i] + (bottom[i] - mid[i]) * u)) for i in range(3))
        for x in range(w):
            px[x, y] = c
    return img


def diagonal_gradient(size: tuple[int, int], tl: tuple[int, int, int], br: tuple[int, int, int]) -> Image.Image:
    w, h = size
    img = Image.new("RGB", (w, h))
    px = img.load()
    denom = max(1.0, float(w + h - 2))
    for y in range(h):
        for x in range(w):
            t = (x + y) / denom
            px[x, y] = tuple(int(round(tl[i] + (br[i] - tl[i]) * t)) for i in range(3))
    return img


def generate_desktop_icons(src: Image.Image) -> None:
    ICONS_DIR.mkdir(parents=True, exist_ok=True)
    for stale_dir in ("android", "ios"):
        target = ICONS_DIR / stale_dir
        if target.exists():
            shutil.rmtree(target)

    # macOS HIG: ~824/1024 padded squircle with soft shadow inside 1024x1024 transparent canvas
    mac_1024 = make_squircle_icon(src, 1024, 824, 0.225, with_shadow=True)
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "HerdrPocket.iconset"
        iconset.mkdir()
        specs = [
            ("icon_16x16.png", 16),
            ("icon_16x16@2x.png", 32),
            ("icon_32x32.png", 32),
            ("icon_32x32@2x.png", 64),
            ("icon_128x128.png", 128),
            ("icon_128x128@2x.png", 256),
            ("icon_256x256.png", 256),
            ("icon_256x256@2x.png", 512),
            ("icon_512x512.png", 512),
            ("icon_512x512@2x.png", 1024),
        ]
        for filename, sz in specs:
            if sz == 1024:
                mac_1024.save(iconset / filename, format="PNG")
            else:
                inner = int(round(sz * 824 / 1024))
                make_squircle_icon(src, sz, inner, 0.225, with_shadow=(sz >= 32)).save(iconset / filename, format="PNG")
        subprocess.run(
            ["/usr/bin/iconutil", "-c", "icns", str(iconset), "-o", str(ICONS_DIR / "icon.icns")],
            check=True,
        )

    # Cross-platform / Windows / Linux PNG icons (crisp minimal margin so taskbar/dock looks substantial)
    png_targets = {
        "32x32.png": (32, 30),
        "64x64.png": (64, 60),
        "128x128.png": (128, 120),
        "128x128@2x.png": (256, 236),
        "icon.png": (512, 472),
        "Square30x30Logo.png": (30, 28),
        "Square44x44Logo.png": (44, 40),
        "Square71x71Logo.png": (71, 65),
        "Square89x89Logo.png": (89, 82),
        "Square107x107Logo.png": (107, 98),
        "Square142x142Logo.png": (142, 130),
        "Square150x150Logo.png": (150, 138),
        "Square284x284Logo.png": (284, 262),
        "Square310x310Logo.png": (310, 286),
        "StoreLogo.png": (50, 46),
    }
    for name, (canvas_sz, inner_sz) in png_targets.items():
        make_squircle_icon(src, canvas_sz, inner_sz, 0.225, with_shadow=False).save(ICONS_DIR / name, format="PNG")

    ico_base = make_squircle_icon(src, 256, 240, 0.225, with_shadow=False)
    ico_base.save(
        ICONS_DIR / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


def paste_badge(base: Image.Image, src: Image.Image, x: int, y: int, size: int, border_color: tuple[int, int, int, int] = (242, 198, 222, 255)) -> None:
    ring_sz = size + 6
    ring = Image.new("RGBA", (ring_sz, ring_sz), (0, 0, 0, 0))
    draw = ImageDraw.Draw(ring)
    draw.rounded_rectangle([0, 0, ring_sz - 1, ring_sz - 1], radius=ring_sz * 0.24, fill=border_color)
    icon = make_squircle_icon(src, size, size, 0.225, with_shadow=False)
    ring.paste(icon, (3, 3), icon)
    base_rgba = base.convert("RGBA")
    base_rgba.paste(ring, (x - 3, y - 3), ring)
    base.paste(base_rgba.convert("RGB"))


def draw_brand_sidebar_panel(src: Image.Image, width: int, height: int) -> Image.Image:
    panel = vertical_gradient((width, height), (255, 246, 250), (253, 229, 242), (241, 232, 255)).convert("RGBA")
    bubble_white = Image.new("RGBA", (width, height), (255, 255, 255, 0))
    ImageDraw.Draw(bubble_white).ellipse([-28, -28, 110, 110], fill=(255, 255, 255, 115))
    panel = Image.alpha_composite(panel, bubble_white)
    bubble_lilac = Image.new("RGBA", (width, height), (235, 214, 255, 0))
    ImageDraw.Draw(bubble_lilac).ellipse([width - 80, height - 110, width + 40, height + 10], fill=(235, 214, 255, 125))
    panel = Image.alpha_composite(panel, bubble_lilac).convert("RGB")

    # Mascot card
    icon_sz = 104
    icon_x = (width - icon_sz) // 2
    icon_y = 40
    paste_badge(panel, src, icon_x, icon_y, icon_sz)

    draw = ImageDraw.Draw(panel)
    f_title = load_font(17, bold=True)
    f_sub = load_font(12, bold=False)
    f_tag = load_font(11, bold=False)

    title = "Herdr Pocket"
    bbox = draw.textbbox((0, 0), title, font=f_title)
    tw = bbox[2] - bbox[0]
    draw.text(((width - tw) // 2, 162), title, fill=(59, 34, 48), font=f_title)

    sub = "Agents in Your Pocket"
    sbbox = draw.textbbox((0, 0), sub, font=f_sub)
    sw = sbbox[2] - sbbox[0]
    draw.text(((width - sw) // 2, 189), sub, fill=(140, 96, 120), font=f_sub)

    # Pill badge at bottom
    pill_w, pill_h = 128, 24
    px = (width - pill_w) // 2
    py = height - 54
    draw.rounded_rectangle([px, py, px + pill_w, py + pill_h], radius=12, fill=(255, 255, 255), outline=(238, 194, 218))
    tag = "desktop companion"
    tbbox = draw.textbbox((0, 0), tag, font=f_tag)
    draw.text((px + (pill_w - (tbbox[2] - tbbox[0])) // 2, py + 5), tag, fill=(176, 78, 128), font=f_tag)

    # Right hairline divider
    draw.line([(width - 1, 0), (width - 1, height - 1)], fill=(238, 212, 226), width=1)
    return panel


def generate_windows_bitmaps(src: Image.Image) -> None:
    WIN_DIR.mkdir(parents=True, exist_ok=True)

    # 1. NSIS Sidebar: 164 x 314, 24-bit uncompressed RGB BMP
    nsis_sidebar = draw_brand_sidebar_panel(src, 164, 314)
    nsis_sidebar.convert("RGB").save(WIN_DIR / "nsis-sidebar.bmp", format="BMP")

    # 2. NSIS Header: 150 x 57, 24-bit uncompressed RGB BMP (white/blush header with mascot on right)
    nsis_header = vertical_gradient((150, 57), (255, 249, 252), (255, 244, 249), (253, 236, 245))
    paste_badge(nsis_header, src, 102, 8, 40)
    ImageDraw.Draw(nsis_header).line([(0, 56), (149, 56)], fill=(240, 214, 228), width=1)
    nsis_header.convert("RGB").save(WIN_DIR / "nsis-header.bmp", format="BMP")

    # 3. WiX Banner: 493 x 58, 24-bit uncompressed RGB BMP (mascot on right, white left where MSI writes title)
    wix_banner = Image.new("RGB", (493, 58), (255, 255, 255))
    # Subtle soft-pink accent wash only on the right half
    wpx = wix_banner.load()
    for x in range(280, 493):
        t = (x - 280) / 212.0
        r = int(round(255 - 2 * t))
        g = int(round(255 - 19 * t))
        b = int(round(255 - 10 * t))
        for y in range(58):
            wpx[x, y] = (r, g, b)
    paste_badge(wix_banner, src, 442, 8, 40)
    ImageDraw.Draw(wix_banner).line([(0, 57), (492, 57)], fill=(236, 214, 226), width=1)
    wix_banner.convert("RGB").save(WIN_DIR / "wix-banner.bmp", format="BMP")

    # 4. WiX Dialog: 493 x 312, 24-bit uncompressed RGB BMP (left 164 branded panel + right 329 pure white)
    wix_dialog = Image.new("RGB", (493, 312), (255, 255, 255))
    left_panel = draw_brand_sidebar_panel(src, 164, 312)
    wix_dialog.paste(left_panel, (0, 0))
    wix_dialog.convert("RGB").save(WIN_DIR / "wix-dialog.bmp", format="BMP")


def render_dmg_bg(src: Image.Image, scale: int) -> Image.Image:
    w, h = 660 * scale, 420 * scale
    bg = diagonal_gradient((w, h), (255, 248, 252), (252, 232, 243)).convert("RGBA")

    # Soft pastel glows (transparent pixels keep the same RGB as the glow so GaussianBlur never muddies to gray)
    glow_white = Image.new("RGBA", (w, h), (255, 255, 255, 0))
    ImageDraw.Draw(glow_white).ellipse([-90 * scale, -80 * scale, 260 * scale, 270 * scale], fill=(255, 255, 255, 135))
    glow_white = glow_white.filter(ImageFilter.GaussianBlur(24 * scale))
    bg = Image.alpha_composite(bg, glow_white)

    glow_lilac = Image.new("RGBA", (w, h), (235, 218, 255, 0))
    ImageDraw.Draw(glow_lilac).ellipse([430 * scale, 200 * scale, 740 * scale, 510 * scale], fill=(235, 218, 255, 115))
    glow_lilac = glow_lilac.filter(ImageFilter.GaussianBlur(24 * scale))
    bg = Image.alpha_composite(bg, glow_lilac)

    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    # Frosted drop-zone cards aligned to icon centers (185, 194) and (475, 194) including bottom Finder labels
    card_w, card_h = 180 * scale, 184 * scale
    cy = 204 * scale
    for cx in (185 * scale, 475 * scale):
        x0 = cx - card_w // 2
        y0 = cy - card_h // 2
        x1 = cx + card_w // 2
        y1 = cy + card_h // 2
        draw.rounded_rectangle(
            [x0, y0, x1, y1],
            radius=28 * scale,
            fill=(255, 255, 255, 185),
            outline=(239, 193, 217, 225),
            width=max(1, int(1.5 * scale)),
        )

    # Top header badge & centered title
    f_title = load_font(22 * scale, bold=True)
    f_hint = load_font(13 * scale, bold=False, cjk=True)
    title = "Herdr Pocket"
    tb = draw.textbbox((0, 0), title, font=f_title)
    tw = tb[2] - tb[0]
    icon_sz = 34 * scale
    gap = 10 * scale
    total_w = icon_sz + gap + tw
    start_x = (w - total_w) // 2
    mini = make_squircle_icon(src, icon_sz, icon_sz, 0.225, with_shadow=False)
    layer.paste(mini, (start_x, 36 * scale), mini)
    draw.text((start_x + icon_sz + gap, 40 * scale), title, fill=(59, 34, 48, 255), font=f_title)

    hint = "将 Herdr Pocket 拖入右侧 Applications 文件夹完成安装"
    hb = draw.textbbox((0, 0), hint, font=f_hint)
    hw = hb[2] - hb[0]
    draw.text(((w - hw) // 2, 348 * scale), hint, fill=(142, 102, 124, 255), font=f_hint)

    # Center arrow between cards (x=298..362, y=204)
    ay = 204 * scale
    ax0, ax1 = 296 * scale, 360 * scale
    stroke = max(2, int(3.5 * scale))
    arrow_color = (232, 90, 156, 255)
    draw.line([(ax0, ay), (ax1, ay)], fill=arrow_color, width=stroke)
    head = 11 * scale
    draw.line([(ax1 - head, ay - head), (ax1, ay), (ax1 - head, ay + head)], fill=arrow_color, width=stroke, joint="curve")

    return Image.alpha_composite(bg, layer).convert("RGB")


def generate_dmg_art(src: Image.Image) -> None:
    DMG_DIR.mkdir(parents=True, exist_ok=True)
    bg1 = render_dmg_bg(src, 1)
    bg2 = render_dmg_bg(src, 2)
    p1 = DMG_DIR / "background.png"
    p2 = DMG_DIR / "background@2x.png"
    out_tiff = DMG_DIR / "background.tiff"
    bg1.save(p1, format="PNG")
    bg2.save(p2, format="PNG")
    subprocess.run(["/usr/bin/tiffutil", "-cathidpicheck", str(p1), str(p2), "-out", str(out_tiff)], check=True)


def clean_adaptive_foreground(path: Path) -> Image.Image:
    """Convert docs/brand/adaptive-foreground.png into seamless 32-bit RGBA with feather over #FEE9F2 seam."""
    src = Image.open(path).convert("RGBA")
    bg_rgb = (254, 233, 242)
    # Feather the outer rectangular edge of the 700x700 safe-zone box cleanly into #FEE9F2
    flat = Image.new("RGBA", src.size, (*bg_rgb, 255))
    # Inner art is roughly within [165..859, 165..859]; mask with rounded rectangle to eliminate faint seam
    w, h = src.size
    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([162, 162, w - 163, h - 163], radius=80, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(10))
    return Image.composite(src, flat, mask)


def generate_harmony_assets(src: Image.Image) -> None:
    HARMONY_APP_MEDIA.mkdir(parents=True, exist_ok=True)
    HARMONY_ENTRY_MEDIA.mkdir(parents=True, exist_ok=True)

    fg_rgba = clean_adaptive_foreground(BRAND_DIR / "adaptive-foreground.png")
    bg_rgba = Image.new("RGBA", (1024, 1024), (254, 233, 242, 255))
    layered_spec = {
        "layered-image": {
            "background": "$media:background",
            "foreground": "$media:foreground",
        }
    }

    app_icon = make_squircle_icon(src, 1024, 960, 0.225, with_shadow=False)
    app_icon.save(HARMONY_APP_MEDIA / "app_icon.png", format="PNG")
    fg_rgba.save(HARMONY_APP_MEDIA / "foreground.png", format="PNG")
    bg_rgba.save(HARMONY_APP_MEDIA / "background.png", format="PNG")
    (HARMONY_APP_MEDIA / "layered_image.json").write_text(json.dumps(layered_spec, indent=2) + "\n", encoding="utf-8")

    entry_icon = make_squircle_icon(src, 512, 480, 0.225, with_shadow=False)
    start_icon = make_squircle_icon(src, 512, 440, 0.225, with_shadow=True)
    entry_icon.save(HARMONY_ENTRY_MEDIA / "icon.png", format="PNG")
    start_icon.save(HARMONY_ENTRY_MEDIA / "startIcon.png", format="PNG")
    fg_rgba.save(HARMONY_ENTRY_MEDIA / "foreground.png", format="PNG")
    bg_rgba.save(HARMONY_ENTRY_MEDIA / "background.png", format="PNG")
    (HARMONY_ENTRY_MEDIA / "layered_image.json").write_text(json.dumps(layered_spec, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    src = Image.open(BRAND_DIR / "icon-1024.png").convert("RGBA")
    generate_desktop_icons(src)
    generate_windows_bitmaps(src)
    generate_dmg_art(src)
    generate_harmony_assets(src)
    print("Generated all desktop, Windows, DMG, and HarmonyOS brand assets.")


if __name__ == "__main__":
    main()
