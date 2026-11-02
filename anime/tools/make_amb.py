#!/usr/bin/env python3
"""Ambient sound effects: rain loop + classroom room tone (stereo 44.1k)."""
import os
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "audio")
SR = 44100


def write_wav(path, data):
    import wave
    d = np.clip(data, -1, 1)
    pcm = (d * 32767).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(2 if pcm.ndim == 2 else 1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def rain(dur=30.0, seed=7):
    rng = np.random.default_rng(seed)
    n = int(dur * SR)
    out = []
    for _ in range(2):
        w = rng.standard_normal(n)
        # lowpass: moving average cascades -> soft rain hiss
        for k in (3, 5, 9):
            w = np.convolve(w, np.ones(k) / k, mode="same")
        w *= 3.2
        # droplet shimmer: sparse impulses smoothed
        imp = np.zeros(n)
        idx = rng.integers(0, n, int(dur * 55))
        imp[idx] = rng.uniform(0.3, 1.0, len(idx))
        imp = np.convolve(imp, rng.uniform(0.4, 1.0, 90) / 45, mode="same")
        w = w * 0.75 + imp * 0.5
        # slow swell
        t = np.linspace(0, dur, n)
        w *= 0.85 + 0.15 * np.sin(2 * np.pi * 0.05 * t + rng.uniform(0, 6))
        out.append(w)
    st = np.stack(out, axis=1)
    st /= np.max(np.abs(st)) * 1.15
    return st


def room(dur=30.0, seed=11):
    rng = np.random.default_rng(seed)
    n = int(dur * SR)
    out = []
    for _ in range(2):
        w = rng.standard_normal(n)
        w = np.cumsum(w)
        w = w / (np.max(np.abs(w)) + 1e-9)          # brown-ish rumble
        w = np.convolve(w, np.ones(41) / 41, mode="same")
        h = rng.standard_normal(n)
        h = np.convolve(h, np.ones(201) / 201, mode="same")  # air hiss
        w = w * 0.5 + h * 0.35
        t = np.linspace(0, dur, n)
        w *= 0.9 + 0.1 * np.sin(2 * np.pi * 0.07 * t)
        out.append(w)
    st = np.stack(out, axis=1)
    st /= np.max(np.abs(st)) * 1.2
    return st * 0.6


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    write_wav(os.path.join(OUT, "amb_rain.wav"), rain())
    write_wav(os.path.join(OUT, "amb_room.wav"), room())
    print("ambience written")
