#!/usr/bin/env python3
"""Soft ambient piano-pad background score (numpy synthesis) for the episode."""
import os
import numpy as np
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SR = 44100

def note(name):
    """Scientific pitch -> Hz."""
    table = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6,
             "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
    n = name[:-1]
    octv = int(name[-1])
    midi = 12 * (octv + 1) + table[n]
    return 440.0 * 2 ** ((midi - 69) / 12)

def adsr(n, a, r, sr=SR):
    env = np.ones(n)
    na, nr = int(a * sr), int(r * sr)
    if na > 0:
        env[:na] = np.linspace(0, 1, na)
    if nr > 0 and nr < n:
        env[-nr:] = np.linspace(1, 0, nr)
    return env

def pad_voice(freq, dur, amp=0.2, detune=0.004):
    n = int(dur * SR)
    t = np.arange(n) / SR
    v = (np.sin(2 * np.pi * freq * t)
         + 0.55 * np.sin(2 * np.pi * freq * (1 + detune) * t + 1.1)
         + 0.55 * np.sin(2 * np.pi * freq * (1 - detune) * t + 2.2)
         + 0.28 * np.sin(2 * np.pi * freq * 2 * t + 0.5)
         + 0.12 * np.sin(2 * np.pi * freq * 3 * t + 1.7))
    env = adsr(n, a=min(1.8, dur * 0.35), r=min(2.2, dur * 0.4))
    # gentle tremolo
    trem = 1 + 0.05 * np.sin(2 * np.pi * 0.28 * t)
    return amp * env * trem * v / 2.5

def pluck(freq, dur=2.2, amp=0.10):
    n = int(dur * SR)
    t = np.arange(n) / SR
    v = (np.sin(2 * np.pi * freq * t) * np.exp(-t * 2.6)
         + 0.4 * np.sin(2 * np.pi * freq * 2 * t) * np.exp(-t * 4.0)
         + 0.2 * np.sin(2 * np.pi * freq * 4 * t) * np.exp(-t * 6.0))
    return amp * v

def render():
    # Am7 -> Fmaj7 -> Cmaj7 -> G  (each chord 6 s), gentle and melancholic-warm
    chords = [
        ["A2", "E3", "A3", "C4", "G4"],
        ["F2", "C3", "F3", "A3", "E4"],
        ["C3", "G3", "C4", "E4", "B4"],
        ["G2", "D3", "G3", "B3", "D4"],
    ]
    chord_dur = 6.0
    loop_len = chord_dur * len(chords)
    total = loop_len * 3  # 72 s loop, will be stream_loop-ed anyway
    L = np.zeros(int(total * SR))
    R = np.zeros(int(total * SR))

    rng = np.random.default_rng(7)
    for li in range(int(total / loop_len) + 1):
        for ci, chord in enumerate(chords):
            start = li * loop_len + ci * chord_dur
            if start >= total:
                break
            # pad layer, slight stereo spread
            for k, nm in enumerate(chord):
                f = note(nm)
                dur = chord_dur + 1.6  # overlap into next chord
                seg = pad_voice(f, dur, amp=0.16 - 0.012 * k)
                i0 = int(start * SR)
                i1 = min(i0 + len(seg), len(L))
                if i1 <= i0:
                    continue
                seg = seg[: i1 - i0]
                pan = 0.5 + (k - 2) * 0.12  # spread voices
                L[i0:i1] += seg * (1 - pan)
                R[i0:i1] += seg * pan
            # soft music-box arpeggio
            order = [chord[2], chord[3], chord[4], chord[3]]
            for pi, nm in enumerate(order):
                t0 = start + 0.4 + pi * 1.35 + rng.uniform(-0.05, 0.05)
                f = note(nm) * 2
                seg = pluck(f, amp=0.055)
                i0 = int(t0 * SR)
                i1 = min(i0 + len(seg), len(L))
                if i1 <= i0:
                    continue
                L[i0:i1] += seg[: i1 - i0] * 0.45
                R[i0:i1] += seg[: i1 - i0] * 0.55

    # soft low shelf rumble removal via simple highpass (difference)
    def highpass(x, a=0.995):
        y = np.empty_like(x)
        y[0] = x[0]
        y[1:] = x[1:] - a * x[:-1]
        return y
    L, R = highpass(L), highpass(R)

    peak = max(np.abs(L).max(), np.abs(R).max(), 1e-9)
    L, R = L / peak * 0.42, R / peak * 0.42
    stereo = np.empty(len(L) * 2, dtype=np.int16)
    stereo[0::2] = (L * 32767).astype(np.int16)
    stereo[1::2] = (R * 32767).astype(np.int16)

    out = os.path.join(ROOT, "audio", "bgm.wav")
    with wave.open(out, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(stereo.tobytes())
    print("wrote", out, f"{len(L)/SR:.1f}s")

if __name__ == "__main__":
    render()
