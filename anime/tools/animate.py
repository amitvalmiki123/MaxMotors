#!/usr/bin/env python3
"""Hybrid animation engine: puppet acting shots + painterly plate shots with VFX.

Renders a scene as a real 25 fps animation:
  - puppet shots: chroma-keyed character pose sheets, walk/talk cycles,
    breathing & sway, over empty painted background plates
  - plate shots: storyboard stills with Ken Burns moves + procedural VFX
    (rain, petals, dust motes, light rays)
Dialogue clips are placed on the scene timeline; talk cycles sync to them.
"""
import os
import math
import wave
import subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
SB = os.path.join(ROOT, "storyboard")
AUD = os.path.join(ROOT, "audio")
WORK = os.path.join(ROOT, "_work", "anim")
FF = "/home/user/.local/lib/python3.11/site-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v9.0.2"
W, H, FPS = 1280, 720, 25
FX = {
    "teach": "asetrate=44100*0.8909,aresample=44100,atempo=1.1225",
    "ayaan": "asetrate=44100*1.1225,aresample=44100,atempo=0.8909",
}

_CHARS = {}


def key_green(img):
    a = np.asarray(img.convert("RGB")).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    bg = (g > 110) & (g - r > 40) & (g - b > 40)
    alpha = np.where(bg, 0, 255).astype("uint8")
    g2 = np.minimum(g, np.maximum(r, b) + 16)
    rgb = np.stack([r, g2, b], axis=-1).astype("uint8")
    im = Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(0.7))
    out = Image.fromarray(rgb, "RGB").convert("RGBA")
    out.putalpha(im)
    return out


def segment_poses(rgba):
    """6 pose crops (row-major) via 2D connected components on the alpha."""
    a = np.asarray(rgba.getchannel("A")).copy()
    rgb = np.asarray(rgba.convert("RGB")).astype(int)
    dark = (rgb.max(axis=2) < 90) & (a > 40)           # opaque grid lines
    a[dark.mean(axis=1) > 0.5, :] = 0
    a[:, dark.mean(axis=0) > 0.5] = 0
    m = Image.fromarray(a, "L")
    m = m.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    a = np.asarray(m)
    S = 4
    small = (a[::S, ::S] > 40)
    Hs, Ws = small.shape
    lab = np.zeros((Hs, Ws), np.int32)
    cur = 0
    comps = []
    for y in range(Hs):
        for x in range(Ws):
            if small[y, x] and lab[y, x] == 0:
                cur += 1
                lab[y, x] = cur
                stack = [(y, x)]
                pix = []
                while stack:
                    cy, cx = stack.pop()
                    pix.append((cy, cx))
                    for dy in (-1, 0, 1):
                        for dx in (-1, 0, 1):
                            ny, nx = cy + dy, cx + dx
                            if 0 <= ny < Hs and 0 <= nx < Ws and small[ny, nx] \
                                    and lab[ny, nx] == 0:
                                lab[ny, nx] = cur
                                stack.append((ny, nx))
                if len(pix) > 150:
                    ys = [p[0] for p in pix]
                    xs = [p[1] for p in pix]
                    comps.append((min(xs) * S, min(ys) * S,
                                  max(xs) * S + S, max(ys) * S + S))
    comps.sort(key=lambda c: (c[1] + c[3]) / 2)
    yc = [(c[1] + c[3]) / 2 for c in comps]
    split = 1
    if len(comps) > 2:
        gaps = [yc[i + 1] - yc[i] for i in range(len(yc) - 1)]
        split = gaps.index(max(gaps)) + 1
    row1 = sorted(comps[:split], key=lambda c: c[0])
    row2 = sorted(comps[split:], key=lambda c: c[0])
    return [rgba.crop(c) for c in row1 + row2]


def load_char(name):
    if name not in _CHARS:
        sheet = key_green(Image.open(os.path.join(ASSETS, f"{name}_sheet.png")))
        poses = segment_poses(sheet)[:6]
        _CHARS[name] = dict(zip(("idle", "to", "th", "sm", "w1", "w2"), poses))
    return _CHARS[name]


def fit_h(img, h):
    return img.resize((max(1, int(img.width * h / img.height)), h), Image.LANCZOS)


# ---------------------------------------------------------------- VFX
class Rain:
    def __init__(self, seed=3, n=140, heavy=False):
        rng = np.random.default_rng(seed)
        self.n = n * (2 if heavy else 1)
        self.x = rng.uniform(0, W, self.n)
        self.y = rng.uniform(0, H, self.n)
        self.v = rng.uniform(900, 1500, self.n) * (1.3 if heavy else 1)
        self.l = rng.uniform(14, 30, self.n) * (1.4 if heavy else 1)
        self.a = rng.uniform(50, 130, self.n).astype(int)
        self.heavy = heavy

    def draw(self, d, t):
        for i in range(self.n):
            y = (self.y[i] + self.v[i] * t) % (H + 60) - 30
            x = (self.x[i] + 0.18 * self.v[i] * t) % (W + 40) - 20
            d.line([x, y, x - self.l[i] * 0.18, y - self.l[i]],
                   fill=(220, 230, 245, self.a[i]), width=1)


class Petals:
    def __init__(self, seed=5, n=26):
        rng = np.random.default_rng(seed)
        self.n = n
        self.x = rng.uniform(0, W, n)
        self.y = rng.uniform(0, H, n)
        self.v = rng.uniform(35, 70, n)
        self.ph = rng.uniform(0, 6.28, n)
        self.s = rng.uniform(4, 8, n)

    def draw(self, d, t):
        for i in range(self.n):
            y = (self.y[i] + self.v[i] * t) % (H + 30) - 15
            x = (self.x[i] + 40 * math.sin(0.7 * t + self.ph[i])) % W
            s = self.s[i]
            d.ellipse([x, y, x + s, y + s * 0.7], fill=(255, 190, 205, 150))


class Dust:
    def __init__(self, seed=9, n=40):
        rng = np.random.default_rng(seed)
        self.n = n
        self.x = rng.uniform(0, W, n)
        self.y = rng.uniform(0, H, n)
        self.v = rng.uniform(6, 16, n)
        self.ph = rng.uniform(0, 6.28, n)
        self.a = rng.uniform(40, 110, n).astype(int)

    def draw(self, d, t):
        for i in range(self.n):
            y = (self.y[i] - self.v[i] * t) % H
            x = (self.x[i] + 18 * math.sin(0.4 * t + self.ph[i])) % W
            d.ellipse([x, y, x + 2.5, y + 2.5], fill=(255, 240, 210, self.a[i]))


class Rays:
    def __init__(self, alpha=46):
        self.layer = None
        self.alpha = alpha

    def draw(self, d, t):
        a = int(self.alpha * (0.8 + 0.2 * math.sin(0.5 * t)))
        d.polygon([(W * 0.62, 0), (W * 0.80, 0), (W * 0.42, H), (W * 0.28, H)],
                  fill=(255, 236, 190, a // 2))
        d.polygon([(W * 0.84, 0), (W * 0.94, 0), (W * 0.62, H), (W * 0.50, H)],
                  fill=(255, 236, 190, a // 3))


VFX = {"rain": lambda: Rain(), "rain_heavy": lambda: Rain(7, heavy=True),
       "petals": lambda: Petals(), "dust": lambda: Dust(), "rays": lambda: Rays()}


# ---------------------------------------------------------------- shots
def kb_crop(img, t, dur, mode):
    """Ken Burns crop of a still to WxH."""
    iw, ih = img.size
    if mode == 0:
        s = 1.0 + 0.10 * t / dur
        cx, cy = 0.5, 0.5
    elif mode == 1:
        s = 1.10 - 0.10 * t / dur
        cx, cy = 0.5, 0.5
    elif mode == 2:
        s = 1.06
        cx, cy = 0.35 + 0.30 * t / dur, 0.5
    else:
        s = 1.06
        cx, cy = 0.65 - 0.30 * t / dur, 0.5
    cw, ch = iw / s, ih / s
    cx, cy = cx * iw, cy * ih
    box = (max(0, cx - cw / 2), max(0, cy - ch / 2),
           min(iw, cx + cw / 2), min(ih, cy + ch / 2))
    return img.crop(tuple(map(int, box))).resize((W, H), Image.LANCZOS)


def actor_x(path, t):
    pts = sorted(path)
    if t <= pts[0][0]:
        return pts[0][1]
    for (t0, x0), (t1, x1) in zip(pts, pts[1:]):
        if t <= t1:
            u = (t - t0) / max(t1 - t0, 1e-6)
            return x0 + (x1 - x0) * u
    return pts[-1][1]


def _speed(path, t):
    pts = sorted(path)
    for (t0, x0), (t1, x1) in zip(pts, pts[1:]):
        if t0 <= t <= t1:
            return abs(x1 - x0) / max(t1 - t0, 1e-6)
    return 0.0


def draw_actor(fr, char, t, spec):
    P = load_char(char)
    h = int(H * spec.get("h", 0.78))
    x = actor_x(spec["path"], t) * W
    moving = _speed(spec["path"], t) > 0.01
    talking = any(s <= t < e for s, e in spec.get("talks", []))
    smiling = any(s <= t < e for s, e in spec.get("smiles", []))
    if moving:
        pose = P["w1"] if int(t * 6) % 2 == 0 else P["w2"]
        bob = -3 * abs(math.sin(2 * math.pi * 3 * t))
    elif talking:
        k = int(t * 8) % 4
        pose = [P["to"], P["th"], P["to"], P["idle"]][k]
        bob = 1.5 * math.sin(2 * math.pi * 1.1 * t)
    else:
        pose = P["sm"] if smiling else P["idle"]
        bob = 1.5 * math.sin(2 * math.pi * 1.1 * t)
    p = fit_h(pose, h)
    if spec.get("face", 1) < 0:
        p = p.transpose(Image.FLIP_LEFT_RIGHT)
    breath = 1.0 + 0.006 * math.sin(2 * math.pi * 1.1 * t + spec.get("ph", 0))
    p = p.resize((p.width, max(2, int(p.height * breath))), Image.BICUBIC)
    sway = 0.7 * math.sin(2 * math.pi * 0.35 * t + spec.get("ph", 0))
    p = p.rotate(sway, resample=Image.BICUBIC, expand=True)
    feet = int(H * spec.get("feet", 0.96))
    d = ImageDraw.Draw(fr, "RGBA")
    sw = int(p.width * 0.28)
    d.ellipse([x - sw, feet - 7, x + sw, feet + 7], fill=(15, 12, 10, 60))
    fr.paste(p, (int(x - p.width / 2), int(feet - p.height + bob)), p)


def render_scene(sid, shots, clips_info):
    """shots: list of dicts; clips_info: list of (clipfile, shot_idx, offset).
    Returns (video_mp4, dialogue_wav, total_dur)."""
    os.makedirs(WORK, exist_ok=True)
    total = sum(sh["dur"] for sh in shots)
    n = int(round(total * FPS))
    vpath = os.path.join(WORK, f"{sid}_v.mp4")
    proc = subprocess.Popen(
        [FF, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
         "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-crf", "19",
         "-pix_fmt", "yuv420p", vpath],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # preload shot backgrounds
    for sh in shots:
        if sh["kind"] == "plate":
            sh["_img"] = Image.open(os.path.join(
                SB if not sh["bg"].startswith("assets/") else ROOT, sh["bg"])).convert("RGB")
        else:
            sh["_img"] = Image.open(os.path.join(ROOT, sh["bg"])).convert("RGB")
        sh["_vfx"] = [VFX[v]() for v in sh.get("vfx", [])]

    starts = []
    acc = 0.0
    for sh in shots:
        starts.append(acc)
        acc += sh["dur"]

    for i in range(n):
        t = i / FPS
        si = max(k for k in range(len(shots)) if starts[k] <= t + 1e-9)
        sh = shots[si]
        lt = t - starts[si]
        fr = kb_crop(sh["_img"], lt, sh["dur"], sh.get("mode", si % 4)).convert("RGBA")
        for a in sorted(sh.get("actors", []), key=lambda a: a.get("h", 0.78)):
            draw_actor(fr, a["char"], lt, a)
        ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(ov, "RGBA")
        for fx in sh["_vfx"]:
            fx.draw(d, t)
        fr = Image.alpha_composite(fr, ov)
        if lt < 0.35:
            fr = Image.blend(Image.new("RGBA", (W, H), (0, 0, 0, 255)), fr, lt / 0.35)
        if sh["dur"] - lt < 0.4:
            k = (sh["dur"] - lt) / 0.4
            fr = Image.blend(Image.new("RGBA", (W, H), (0, 0, 0, 255)), fr, k)
        proc.stdin.write(fr.convert("RGB").tobytes())
    proc.stdin.close()
    proc.wait()

    # dialogue track
    sr = 44100
    track = bytearray(int(total * sr) * 4)
    for entry in clips_info:
        clip, si, off = entry[0], entry[1], entry[2]
        fx = entry[3] if len(entry) > 3 else None
        cmd = [FF, "-y", "-i", os.path.join(AUD, clip)]
        if fx:
            cmd += ["-af", FX[fx]]
        cmd += ["-ar", str(sr), "-ac", "2", "-c:a", "pcm_s16le",
                os.path.join(WORK, "_tmp.wav")]
        subprocess.run(cmd, check=True, capture_output=True)
        with wave.open(os.path.join(WORK, "_tmp.wav"), "rb") as w:
            data = w.readframes(w.getnframes())
        o = int((starts[si] + off) * sr) * 4
        track[o:o + len(data)] = data
    dwav = os.path.join(WORK, f"{sid}_dlg.wav")
    with wave.open(dwav, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(sr)
        w.writeframes(bytes(track))
    return vpath, dwav, total
