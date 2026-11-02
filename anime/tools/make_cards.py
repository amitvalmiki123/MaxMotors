#!/usr/bin/env python3
"""Generate title/end cards for 'Tum Kahoge Nahi, Toh Main Keh Dungi' S1E1."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageFilter
from htext import draw_text

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SB = os.path.join(ROOT, "storyboard")
CARDS = os.path.join(ROOT, "cards")
FONTS = os.path.join(ROOT, "assets", "fonts")
W, H = 1280, 720

F_TITLE = os.path.join(FONTS, "NotoSansDevanagari-Bold.ttf")
F_SUB = os.path.join(FONTS, "NotoSansDevanagari-SemiBold.ttf")
F_META = os.path.join(FONTS, "NotoSansDevanagari-Regular.ttf")
F_SMALL = os.path.join(FONTS, "NotoSansDevanagari-Light.ttf")
F_LATIN = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
SH = (0, 0, 0, 175)


def load_bg(path, darken=0.0, blur=0):
    img = Image.open(path).convert("RGB").resize((W, H))
    if blur:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    if darken > 0:
        img = Image.blend(img, Image.new("RGB", (W, H), (10, 8, 20)), darken)
    return img.convert("RGBA")


def bottom_gradient(img, strength=160):
    grad = Image.new("L", (1, H))
    for y in range(H):
        a = int(strength * (y - H * 0.45) / (H * 0.55)) if y > H * 0.45 else 0
        grad.putpixel((0, y), max(0, min(255, a)))
    grad = grad.resize((W, H))
    black = Image.new("RGBA", (W, H), (5, 5, 15, 255))
    black.putalpha(grad)
    return Image.alpha_composite(img, black)


def make_title():
    img = bottom_gradient(load_bg(os.path.join(SB, "s01_1_school_rain.jpg"),
                                  darken=0.22))
    draw_text(img, (W // 2, 92), "एक सच्ची प्रेम कहानी", F_SMALL, 30,
              (255, 235, 200, 240), shadow=SH, sdx=2, sdy=2)
    draw_text(img, (W // 2, 235), "तुम कहोगे नहीं,", F_TITLE, 92,
              (255, 255, 255, 255), shadow=SH, sdx=4, sdy=5)
    draw_text(img, (W // 2, 350), "तो मैं कह दूंगी", F_TITLE, 92,
              (255, 255, 255, 255), shadow=SH, sdx=4, sdy=5)
    draw_text(img, (W // 2, 465), "पहली मुलाकात", F_SUB, 50,
              (255, 205, 120, 255), shadow=SH, sdx=3, sdy=3)
    draw_text(img, (W // 2, 555), "सीज़न 1 — एपिसोड 1", F_META, 34,
              (230, 235, 255, 245), shadow=SH, sdx=3, sdy=3)
    draw_text(img, (W // 2, 655), "TUM KAHOGE NAHI, TOH MAIN KEH DUNGI  —  S1E1",
              F_LATIN, 23, (215, 220, 235, 225), shadow=SH, sdx=2, sdy=2)
    img.convert("RGB").save(os.path.join(CARDS, "title.png"))


def make_end():
    img = bottom_gradient(load_bg(os.path.join(SB, "s07_8_umbrella_walk.jpg")
                                  if os.path.exists(os.path.join(SB, "s07_8_umbrella_walk.jpg"))
                                  else os.path.join(SB, "s01_1_school_rain.jpg"),
                                  darken=0.58, blur=6))
    draw_text(img, (W // 2, 250), "अगले एपिसोड में...", F_SUB, 60,
              (255, 255, 255, 255), shadow=SH, sdx=4, sdy=4)
    draw_text(img, (W // 2, 370), "सीज़न 1 जारी है", F_META, 38,
              (255, 205, 120, 250), shadow=SH, sdx=3, sdy=3)
    draw_text(img, (W // 2, 500), "तुम कहोगे नहीं, तो मैं कह दूंगी", F_META, 32,
              (225, 230, 245, 240), shadow=SH, sdx=3, sdy=3)
    draw_text(img, (W // 2, 630), "— समाप्त —", F_SMALL, 26,
              (200, 205, 220, 220), shadow=SH, sdx=2, sdy=2)
    img.convert("RGB").save(os.path.join(CARDS, "end.png"))


if __name__ == "__main__":
    os.makedirs(CARDS, exist_ok=True)
    make_title()
    make_end()
    print("cards written to", CARDS)
