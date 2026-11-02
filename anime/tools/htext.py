#!/usr/bin/env python3
"""Devanagari text rendering: uharfbuzz shaping + freetype glyph bitmaps -> PIL.

PIL's built-in layout lacks Raqm/Harfbuzz, which breaks Hindi conjuncts and
matras. This module shapes text correctly and pastes real glyph bitmaps.
"""
from PIL import Image
import uharfbuzz as hb
import freetype


def _shape(text, font_path):
    blob = hb.Blob.from_file_path(font_path)
    hface = hb.Face(blob)
    hfont = hb.Font(hface)
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hfont, buf)
    items = [(i.codepoint, p.x_advance, p.x_offset, p.y_offset)
             for i, p in zip(buf.glyph_infos, buf.glyph_positions)]
    return items, hface.upem


def _glyph_image(face, gid, fill):
    face.load_glyph(gid, freetype.FT_LOAD_RENDER)
    bmp = face.glyph.bitmap
    w, h, pitch = bmp.width, bmp.rows, bmp.pitch
    if not (w and h):
        return None, face.glyph.bitmap_left, face.glyph.bitmap_top
    data = bytes(bmp.buffer)
    rows = []
    if pitch >= 0:
        for r in range(h):
            rows.append(data[r * pitch:r * pitch + w])
    else:
        p = -pitch
        base = (h - 1) * p
        for r in range(h):
            off = base - r * p
            rows.append(data[off:off + w])
    gray = Image.frombytes("L", (w, h), b"".join(rows))
    solid = Image.new("RGBA", (w, h), fill)
    solid.putalpha(gray)
    return solid, face.glyph.bitmap_left, face.glyph.bitmap_top


def render_layer(text, font_path, size, fill=(255, 255, 255, 255)):
    """Return (RGBA layer, baseline_y_within_layer)."""
    items, upem = _shape(text, font_path)
    if not items:
        return Image.new("RGBA", (1, 1), (0, 0, 0, 0)), 0
    scale = size / upem
    face = freetype.Face(font_path)
    face.set_pixel_sizes(0, size)
    total_adv = sum(a for _, a, _, _ in items) * scale
    pad = int(size * 0.6)
    W = int(total_adv) + 2 * pad
    H = int(size * 2.4)
    baseline = int(size * 1.6)
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    pen = 0.0
    for gid, adv, xoff, yoff in items:
        g, bleft, btop = _glyph_image(face, gid, fill)
        if g is not None:
            left = int(round(pen + xoff * scale)) + pad + bleft
            top = int(round(baseline - yoff * scale)) - btop
            canvas.paste(g, (left, top), g)
        pen += adv * scale
    bbox = canvas.getbbox()
    if bbox:
        m = 2
        bbox = (max(bbox[0] - m, 0), max(bbox[1] - m, 0),
                min(bbox[2] + m, W), min(bbox[3] + m, H))
        canvas = canvas.crop(bbox)
        baseline -= bbox[1]
    return canvas, baseline


def draw_text(img, xy, text, font_path, size, fill=(255, 255, 255, 255),
              anchor="mm", shadow=None, sdx=3, sdy=3):
    """Draw shaped Devanagari text onto RGBA img. Returns pasted box."""
    layer, _ = render_layer(text, font_path, size, fill)
    w, h = layer.size
    x, y = xy
    if anchor[0] == "m":
        x -= w // 2
    elif anchor[0] == "r":
        x -= w
    if anchor[1] == "m":
        y -= h // 2
    elif anchor[1] == "b":
        y -= h
    if shadow is not None:
        sh = Image.new("RGBA", (w, h), shadow)
        sh.putalpha(layer.getchannel("A"))
        img.paste(sh, (x + sdx, y + sdy), sh)
    img.paste(layer, (x, y), layer)
    return (x, y, x + w, y + h)


def text_width(text, font_path, size):
    items, upem = _shape(text, font_path)
    return sum(a for _, a, _, _ in items) * size / upem
