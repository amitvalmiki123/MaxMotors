#!/usr/bin/env python3
"""Assembler for 'Tum Kahoge Nahi, Toh Main Keh Dungi' S1E1.

Scene durations follow the script PDF timestamps (total locked to 20:00).
Each scene: dialogue track (TTS clips + gaps) over Ken Burns segments built
from storyboard stills, plus scene ambience; final pass mixes the score.

Usage:  python3 build.py preview | full
"""
import os
import sys
import wave
import shutil
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # anime/
SB = os.path.join(ROOT, "storyboard")
AUD = os.path.join(ROOT, "audio")
WORK = os.path.join(ROOT, "_work")
OUT = os.path.join(ROOT, "out")

FF = "/home/user/.local/lib/python3.11/site-packages/imageio_ffmpeg/binaries/ffmpeg-linux-x86_64-v9.0.2"
W, H, FPS = 1280, 720, 25
GAP_LEAD, GAP_BETWEEN = 0.9, 1.25

# pitch FX (semitones) applied while decoding mp3 -> wav
FX = {
    "teach": "asetrate=44100*0.8909,aresample=44100,atempo=1.1225",   # -2 st
    "ayaan": "asetrate=44100*1.1225,aresample=44100,atempo=0.8909",   # +2 st
}

try:
    import animate
    import scenes_hybrid
    HYBRID = scenes_hybrid.SCENES
except Exception:
    HYBRID = {}

# (id, target seconds, ambience, [images], [(clip, fx|None)])
SCENES = [
    ("title", 6, None, ["cards/title.png"], []),
    ("s1", 114, "amb_rain.wav",
     ["s01_1_school_rain.jpg", "s01_2_roof_umbrella.jpg", "s01_3_sketch_close.jpg",
      "s01_4_amito_face.jpg", "s01_5_stairs.jpg"],
     [("01_amito_vo_open.mp3", None)]),
    ("s2", 178, "amb_room.wav",
     ["s02_1_door.jpg", "s02_2_handshake.jpg", "s02_3_sketchbook_fall.jpg",
      "s02_4_page_close.jpg", "s02_5_backbench.jpg"],
     [("02_punumi_sorry.mp3", None), ("03_teacher.mp3", "teach"),
      ("04_punumi_hi.mp3", None), ("05_amito_name.mp3", None),
      ("06_punumi_mrquiet.mp3", None), ("07_punumi_sketch.mp3", None),
      ("08_amito_kuchnahi.mp3", None), ("09_punumi_kiska.mp3", None),
      ("10_amito_patannahi.mp3", None)]),
    ("s3", 180, "amb_room.wav",
     ["s03_1_library_table.jpg", "s03_2_plant_sketch.jpg", "s03_3_shelf_peek.jpg",
      "s03_4_number.jpg"],
     [("11_punumi_deal.mp3", None), ("12_amito_theekhai.mp3", None),
      ("13_punumi_aankhein.mp3", None), ("14_amito_dhyan.mp3", None),
      ("15_punumi_sharma.mp3", None), ("16_rohan_alag.mp3", None),
      ("17_sana_shh.mp3", None), ("18_punumi_number.mp3", None)]),
    ("s4", 180, "amb_room.wav",
     ["s04_1_corridor_evening.jpg", "s04_2_piano_sing.jpg", "s04_3_doorway.jpg",
      "s04_4_blush.jpg"],
     [("19_punumi_aa_jao.mp3", None), ("20_amito_sorry.mp3", None),
      ("21_punumi_kaisa.mp3", None), ("22_amito_sundar.mp3", None),
      ("23_punumi_kal_bhi.mp3", None)]),
    ("s5", 180, "amb_room.wav",
     ["s05_1_notice_board.jpg", "s05_2_amito_watches.jpg", "s05_3_rohan_stops.jpg",
      "s05_4_rain_alone.jpg"],
     [("24_ayaan_duet.mp3", "ayaan"), ("25_punumi_sach.mp3", None),
      ("26_ayaan_shaam.mp3", "ayaan"), ("27_rohan_bol.mp3", None),
      ("28_amito_khush.mp3", None), ("29_rohan_gussa.mp3", None)]),
    ("s6", 180, "amb_room.wav",
     ["s06_1_canteen.jpg", "s06_2_flashback_class.jpg", "s06_3_flashback_music.jpg",
      "s06_4_punumi_tears.jpg"],
     [("30_sana_baat.mp3", None), ("31_punumi_kya.mp3", None),
      ("32_rohan_pages.mp3", None), ("33_rohan_darta.mp3", None),
      ("34_punumi_bewakoof.mp3", None), ("35_sana_naraz.mp3", None),
      ("36_punumi_dukh.mp3", None)]),
    ("s7", 172, "amb_rain.wav",
     ["s07_1_roof_heavy_rain.jpg", "s07_2_door_soaked.jpg", "s07_3_amito_look_up.jpg",
      "s07_4_punumi_walks.jpg", "s07_5_face_to_face.jpg", "s07_6_punumi_tears_smile.jpg",
      "s07_7_amito_cries_smiles.jpg", "s07_8_umbrella_walk.jpg"],
     [("37_amito_tum_yahan.mp3", None), ("38_punumi_rohan_ne.mp3", None),
      ("39_amito_maaf.mp3", None), ("40_punumi_kyun_nahi.mp3", None),
      ("41_amito_dar.mp3", None), ("42_punumi_chuppi.mp3", None),
      ("43_punumi_keh_dungi.mp3", None), ("44_amito_shuru_se.mp3", None),
      ("45_amito_vo_end.mp3", None)]),
    ("end", 10, None, ["cards/end.png"], []),
]


def run(cmd, label=""):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"FAILED: {label}\n{r.stderr[-2000:]}")
        sys.exit(1)
    return r


def wav_info(p):
    with wave.open(p, "rb") as w:
        return w.getnframes() / w.getframerate()


def silence(path, dur):
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(44100)
        w.writeframes(b"\x00" * int(44100 * 4 * dur))


def clip_wav(name, fx, dst):
    cmd = [FF, "-y", "-i", os.path.join(AUD, name)]
    if fx:
        cmd += ["-af", FX[fx]]
    cmd += ["-ar", "44100", "-ac", "2", "-c:a", "pcm_s16le", dst]
    run(cmd, f"decode {name}")


def dialogue_track(clips, dst):
    with wave.open(dst, "wb") as out:
        out.setnchannels(2); out.setsampwidth(2); out.setframerate(44100)
        out.writeframes(b"\x00" * int(44100 * 4 * GAP_LEAD))
        for i, c in enumerate(clips):
            with wave.open(c, "rb") as w:
                out.writeframes(w.readframes(w.getnframes()))
            gap = GAP_BETWEEN if i < len(clips) - 1 else 0.4
            out.writeframes(b"\x00" * int(44100 * 4 * gap))


def segment(img, dur, mode, dst):
    fi = max(int(round(dur * FPS)), 2)
    m = mode % 6
    if m == 0:
        z, x, y = f"min(1+0.12*on/{fi},1.12)", "(iw-iw/zoom)/2", "(ih-ih/zoom)/2"
    elif m == 1:
        z, x, y = f"max(1.12-0.12*on/{fi},1.0)", "(iw-iw/zoom)/2", "(ih-ih/zoom)/2"
    elif m == 2:
        z, x, y = "1.08", f"(iw-iw/zoom)*(0.15+0.7*on/{fi})", "(ih-ih/zoom)/2"
    elif m == 3:
        z, x, y = f"min(1.45+0.15*on/{fi},1.6)", "(iw-iw/zoom)/2", "(ih-ih/zoom)*0.35"
    elif m == 4:
        z, x, y = "1.55", f"(iw-iw/zoom)*(0.85-0.7*on/{fi})", "(ih-ih/zoom)*0.4"
    else:
        z, x, y = "1.06", "(iw-iw/zoom)/2", f"(ih-ih/zoom)*(0.8-0.6*on/{fi})"
    fo = max(dur - 0.4, 0.05)
    vf = ("crop='min(iw,ih*16/9)':'min(ih,iw*9/16)',scale=3840:-2:flags=lanczos,"
          f"zoompan=z='{z}':x='{x}':y='{y}':d={fi}:s={W}x{H}:fps={FPS},"
          f"fade=t=in:st=0:d=0.35,fade=t=out:st={fo:.3f}:d=0.4,format=yuv420p")
    src = img if os.path.isabs(img) else os.path.join(
        ROOT if img.startswith("cards/") else SB, img)
    run([FF, "-y", "-i", src, "-vf", vf, "-frames:v", str(fi), "-r", str(FPS),
         "-c:v", "libx264", "-preset", "medium", "-crf", "19",
         "-pix_fmt", "yuv420p", dst], f"segment {img}")


def concat(paths, dst):
    lst = dst + ".txt"
    with open(lst, "w") as f:
        f.writelines(f"file '{p}'\n" for p in paths)
    run([FF, "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", dst],
        f"concat {dst}")


def build(mode):
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    scenes = []
    for sc in SCENES:
        sid, tgt, amb, imgs, clips = sc
        have = all(os.path.exists(os.path.join(AUD, c)) for c, _ in clips) \
            and all(os.path.exists(os.path.join(
                ROOT if i.startswith("cards/") else SB, i)) for i in imgs)
        if mode == "full" and not have:
            print(f"missing assets for {sid} — aborting full build"); sys.exit(2)
        if have:
            scenes.append(sc)
        elif mode == "preview":
            print(f"skip {sid} (assets pending)")

    parts = []
    for sid, tgt, amb, imgs, clips in scenes:
        print(f"== {sid} target {tgt}s ==", flush=True)
        dwav = os.path.join(WORK, f"{sid}_dlg.wav")
        hybrid = False
        if sid in HYBRID:
            shots, hclips = HYBRID[sid]
            ok = all(os.path.exists(os.path.join(
                ROOT if sh["bg"].startswith("assets/") else SB, sh["bg"]))
                for sh in shots)
            if ok:
                vcat, dwav, total = animate.render_scene(sid, shots, hclips)
                print(f"   hybrid animated {total:.1f}s", flush=True)
                hybrid = True
        if not hybrid:
            if clips:
                ws = []
                for i, (c, fx) in enumerate(clips):
                    d = os.path.join(WORK, f"{sid}_c{i}.wav")
                    clip_wav(c, fx, d)
                    ws.append(d)
                dialogue_track(ws, dwav)
            else:
                silence(dwav, 1.0)
            # plan segments: ~10-13s each, >=1 per image, cycle motion modes
            n_img = len(imgs)
            per_img = max(1, -(-tgt // (n_img * 12)))          # ceil(tgt/(n*12))
            segs = []
            mm = sum(map(ord, sid)) % 2
            for i, img in enumerate(imgs):
                for k in range(per_img):
                    segs.append((img, mm))
                    mm += 1
            base = tgt / len(segs)
            vparts = []
            for i, (img, m) in enumerate(segs):
                p = os.path.join(WORK, f"{sid}_v{i}.mp4")
                segment(img, base, m, p)
                vparts.append(p)
            vcat = os.path.join(WORK, f"{sid}_v.mp4")
            concat(vparts, vcat)
        # audio: dialogue + ambience loop, padded to target
        ambf = os.path.join(AUD, amb) if amb else None
        scmp4 = os.path.join(WORK, f"{sid}_scene.mp4")
        if ambf and os.path.exists(ambf):
            run([FF, "-y", "-i", vcat, "-i", dwav, "-stream_loop", "-1", "-i", ambf,
                 "-filter_complex",
                 f"[1:a]apad=whole_dur={tgt}[d];[2:a]volume=0.28,apad=whole_dur={tgt},"
                 f"afade=t=in:st=0:d=1.5,afade=t=out:st={tgt-2}:d=2[a];"
                 f"[d][a]amix=inputs=2:duration=longest:normalize=0[ma]",
                 "-map", "0:v", "-map", "[ma]", "-t", str(tgt),
                 "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", scmp4], f"mux {sid}")
        else:
            run([FF, "-y", "-i", vcat, "-i", dwav, "-map", "0:v", "-map", "1:a",
                 "-t", str(tgt), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                 scmp4], f"mux {sid}")
        parts.append(scmp4)

    joined = os.path.join(WORK, "joined.mp4")
    concat(parts, joined)
    final = os.path.join(OUT, f"tum_kahoge_nahi_s1e1_{mode}.mp4")
    bgm = os.path.join(AUD, "bgm.wav")
    if os.path.exists(bgm):
        run([FF, "-y", "-i", joined, "-stream_loop", "-1", "-i", bgm,
             "-filter_complex",
             "[1:a]volume=0.14,afade=t=in:st=0:d=3[bg];"
             "[0:a][bg]amix=inputs=2:duration=first:normalize=0[a]",
             "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac",
             "-b:a", "192k", final], "bgm mix")
    else:
        shutil.copy(joined, final)
    subprocess.run([FF, "-hide_banner", "-i", final], capture_output=True)
    print(f"DONE: {final} ({os.path.getsize(final)/1e6:.1f} MB)")


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "preview")
