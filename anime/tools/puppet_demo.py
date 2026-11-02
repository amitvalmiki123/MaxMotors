#!/usr/bin/env python3
"""Puppet limited-animation demo: green-sheet character over painted bg.

Builds a real animated shot (walk cycle + talk cycle + breathing/sway)
at 25 fps, mixed with the Hindi dialogue clip and the score.
"""
import os
import wave
import subprocess
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
AUD = os.path.join(ROOT, "audio")
WORK = os.path.join(ROOT, "_work", "demo")
OUT = os.path.join(ROOT, "out")
FF = "/home/user/.local/lib/python3.11/site-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v9.0.2"
W, H, FPS = 1280, 720, 25


def key_green(img):
    a = np.asarray(img.convert("RGB")).astype(int)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    bg = (g > 110) & (g - r > 40) & (g - b > 40)
    alpha = np.where(bg, 0, 255).astype("uint8")
    g2 = np.minimum(g, np.maximum(r, b) + 16)          # green despill
    rgb = np.stack([r, g2, b], axis=-1).astype("uint8")
    im = Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(0.7))
    out = Image.fromarray(rgb, "RGB").convert("RGBA")
    out.putalpha(im)
    return out


def segment_poses(rgba):
    """Return 6 pose images (row-major) via projection profiling."""
    a = np.asarray(rgba.getchannel("A"))
    m = Image.fromarray(a, "L")
    m = m.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.MaxFilter(5))
    a = np.asarray(m)
    rows = (a > 40).sum(axis=1)
    bands, in_b = [], False
    for y, v in enumerate(rows):
        if v > 2 and not in_b:
            in_b, y0 = True, y
        elif v <= 2 and in_b:
            in_b = False
            if y - y0 > 40:
                bands.append((y0, y))
    poses = []
    for (y0, y1) in bands:
        cols = (a[y0:y1] > 40).sum(axis=0)
        xb, in_x = [], False
        for x, v in enumerate(cols):
            if v > 1 and not in_x:
                in_x, x0 = True, x
            elif v <= 1 and in_x:
                in_x = False
                if x - x0 > 30:
                    xb.append((x0, x))
        for (x0, x1) in xb:
            poses.append(rgba.crop((x0, y0, x1, y1)))
    return poses


def fit_height(img, h):
    w = max(1, int(img.width * h / img.height))
    return img.resize((w, h), Image.LANCZOS)


def bg_frame(bg, t, dur):
    s = 1.0 + 0.05 * (t / dur)
    cw, ch = W / s, H / s
    cx, cy = W * 0.5, H * 0.52
    box = (cx - cw / 2, cy - ch / 2, cx + cw / 2, cy + ch / 2)
    return bg.crop(tuple(map(int, box))).resize((W, H), Image.LANCZOS)


def paste_puppet(frame, pose, x_c, feet_y, scaleY=1.0, rot=0.0, dy=0):
    from PIL import ImageDraw
    d = ImageDraw.Draw(frame, "RGBA")
    sw = int(pose.width * 0.30)
    d.ellipse([x_c - sw, feet_y - 8, x_c + sw, feet_y + 8], fill=(20, 15, 10, 70))
    p = pose
    if scaleY != 1.0:
        p = p.resize((p.width, max(2, int(p.height * scaleY))), Image.BICUBIC)
    if rot:
        p = p.rotate(rot, resample=Image.BICUBIC, expand=True)
    frame.paste(p, (int(x_c - p.width / 2), int(feet_y - p.height + dy)), p)


def main():
    os.makedirs(WORK, exist_ok=True)
    sheet = key_green(Image.open(os.path.join(ASSETS, "amito_sheet.png")))
    poses = segment_poses(sheet)
    print("poses found:", len(poses))
    idle, talk_o, talk_h, smile, walk1, walk2 = poses[:6]
    bg = Image.open(os.path.join(ASSETS, "bg_classroom_empty.png")).convert("RGB")

    # dialogue clip -> wav
    dw = os.path.join(WORK, "dlg.wav")
    subprocess.run([FF, "-y", "-i", os.path.join(AUD, "14_amito_dhyan.mp3"),
                    "-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", dw],
                   check=True, capture_output=True)
    with wave.open(dw, "rb") as wv:
        dlg = wv.readframes(wv.getnframes())
        dl = wv.getnframes() / wv.getframerate()
    print("dialogue", dl)

    T_WALK, T_LEAD, T_TAIL = 3.0, 0.5, 1.4
    t_talk = T_WALK + T_LEAD
    dur = t_talk + dl + T_TAIL
    n = int(dur * FPS)
    PH = int(H * 0.78)
    P = {k: fit_height(v, PH) for k, v in
         dict(idle=idle, to=talk_o, th=talk_h, sm=smile, w1=walk1, w2=walk2).items()}

    frames = []
    for i in range(n):
        t = i / FPS
        fr = bg_frame(bg, t, dur).convert("RGBA")
        import math
        breath = 1.0 + 0.006 * math.sin(2 * math.pi * 1.1 * t)
        sway = 0.7 * math.sin(2 * math.pi * 0.35 * t)
        if t < T_WALK:                       # walk in from left
            u = t / T_WALK
            x = W * (0.12 + 0.46 * u)
            step = P["w1"] if int(t * 6) % 2 == 0 else P["w2"]
            bob = 3 * abs(math.sin(2 * math.pi * 3 * t))
            paste_puppet(fr, fit_height(step, PH), x, H * 0.96,
                         scaleY=breath, rot=sway * 0.4, dy=-bob)
        else:
            x = W * 0.58
            if t < t_talk:
                pose = P["idle"]
            elif t < t_talk + dl:            # talk cycle @8fps
                k = int((t - t_talk) * 8) % 4
                pose = [P["to"], P["th"], P["to"], P["idle"]][k]
            else:
                pose = P["sm"]
            bob = 1.5 * math.sin(2 * math.pi * 1.1 * t)
            paste_puppet(fr, pose, x, H * 0.96, scaleY=breath, rot=sway, dy=bob)
        fr.convert("RGB").save(os.path.join(WORK, f"f{i:04d}.png"))

    # audio: dialogue at t_talk + bgm
    sr = 44100
    total = int(dur * sr)
    track = bytearray(total * 4)
    off = int(t_talk * sr) * 4
    track[off:off + len(dlg)] = dlg
    open(os.path.join(WORK, "track.wav"), "wb").close()
    with wave.open(os.path.join(WORK, "track.wav"), "wb") as wv:
        wv.setnchannels(2); wv.setsampwidth(2); wv.setframerate(sr)
        wv.writeframes(bytes(track))
    vid = os.path.join(WORK, "v.mp4")
    subprocess.run([FF, "-y", "-framerate", str(FPS),
                    "-i", os.path.join(WORK, "f%04d.png"),
                    "-c:v", "libx264", "-crf", "19", "-pix_fmt", "yuv420p", vid],
                   check=True, capture_output=True)
    final = os.path.join(OUT, "demo_puppet.mp4")
    subprocess.run([FF, "-y", "-i", vid, "-i", os.path.join(WORK, "track.wav"),
                    "-stream_loop", "-1", "-i", os.path.join(AUD, "bgm.wav"),
                    "-filter_complex",
                    "[2:a]volume=0.12,afade=t=in:st=0:d=1.5[bg];"
                    "[1:a][bg]amix=inputs=2:duration=first:normalize=0[a]",
                    "-map", "0:v", "-map", "[a]", "-c:v", "copy",
                    "-c:a", "aac", "-b:a", "192k", "-shortest", final],
                   check=True, capture_output=True)
    print("DEMO:", final, os.path.getsize(final) // 1024, "KB", f"{dur:.1f}s")


if __name__ == "__main__":
    main()
