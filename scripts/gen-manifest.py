#!/usr/bin/env python3
# ============================================================
# 草屋 · 曲库与藏品清单
#
#   上传音频到 assets/audio/、图片到 assets/img/ 之后跑一次：
#
#       python3 scripts/gen-manifest.py
#
#   它会扫一遍这两个目录，写成 assets/manifest.json，
#   页面读那个清单 —— 网页没法自己列目录，这一步就是「读目录」。
#
#   可选：在目录里放一个 _meta.json 补标题与说明，形如
#       { "雨落草檐.mp3": { "title": "雨落草檐", "sub": "檐下流水" } }
#   没写的文件用文件名当标题。
#
#   每次运行输出稳定（按文件名排序、不写生成时间），
#   所以内容没变时 git 里看不出改动。
# ============================================================

import json
import os
import struct
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUDIO_DIR = os.path.join(ROOT, "assets", "audio")
IMG_DIR = os.path.join(ROOT, "assets", "img")
OUT = os.path.join(ROOT, "assets", "manifest.json")

AUDIO_EXT = (".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav", ".flac")
IMG_EXT = (".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif")

# 以 _ 或 . 开头的文件不进清单（草稿、说明、原始素材）
def visible(name):
    return not name.startswith(("_", "."))


def humanize(filename):
    """文件名 → 标题：去掉扩展名、前导序号，把 - _ 换成空格。"""
    base = os.path.splitext(filename)[0]
    base = base.strip()
    # 「01-雨落草檐」「03_rain」这类前导序号去掉
    i = 0
    while i < len(base) and (base[i].isdigit() or base[i] in "._- "):
        i += 1
    if 0 < i < len(base):
        base = base[i:]
    return base.replace("-", " ").replace("_", " ").strip() or filename


def read_meta(directory):
    path = os.path.join(directory, "_meta.json")
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError) as e:
        print("  ! _meta.json 读不动，忽略：%s" % e, file=sys.stderr)
        return {}


def scan_audio():
    meta = read_meta(AUDIO_DIR)
    out = []
    for name in sorted(os.listdir(AUDIO_DIR)) if os.path.isdir(AUDIO_DIR) else []:
        if not visible(name) or not name.lower().endswith(AUDIO_EXT):
            continue
        m = meta.get(name, {})
        if m.get("skip"):
            continue
        item = {
            "file": name,
            "title": m.get("title") or humanize(name),
        }
        if m.get("sub"):
            item["sub"] = m["sub"]
        out.append(item)
    return out


def image_size(path):
    """取图的宽高，只读头部。读不出就返回 None，不影响清单生成。
    非 JPEG（png/webp/avif/gif）交给 ImageMagick，没有就跳过。"""
    if path.lower().endswith((".jpg", ".jpeg")):
        return jpeg_size(path)
    try:
        import subprocess
        out = subprocess.check_output(
            ["identify", "-format", "%w %h", path + "[0]"],
            stderr=subprocess.DEVNULL)
        w, h = out.decode().split()
        return int(w), int(h)
    except Exception:
        return None


def jpeg_size(path):
    """只读头部，取 JPEG 的宽高。读不出就返回 None，不影响清单生成。"""
    try:
        with open(path, "rb") as f:
            if f.read(2) != b"\xff\xd8":
                return None
            while True:
                b = f.read(1)
                if not b:
                    return None
                if b != b"\xff":
                    continue
                while b == b"\xff":
                    b = f.read(1)
                marker = b[0]
                # 无长度字段的标记
                if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                    continue
                length = struct.unpack(">H", f.read(2))[0]
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    f.read(1)                                  # 精度
                    h, w = struct.unpack(">HH", f.read(4))
                    return w, h
                f.seek(length - 2, 1)
    except (OSError, struct.error):
        return None


def scan_img():
    meta = read_meta(IMG_DIR)
    out = []
    names = sorted(os.listdir(IMG_DIR)) if os.path.isdir(IMG_DIR) else []
    for name in names:
        if not visible(name) or not name.lower().endswith(IMG_EXT):
            continue
        m = meta.get(name, {})
        if m.get("skip"):
            continue

        item = {"file": name}
        if m.get("title"):
            item["title"] = m["title"]
        if m.get("note"):
            item["note"] = m["note"]
        if m.get("alt"):
            item["alt"] = m["alt"]

        # 首图（或显式标注的）走横长陈位；宽高比大于 2 的也归此列
        size = image_size(os.path.join(IMG_DIR, name))
        if size:
            w, h = size
            ratio = w / max(h, 1)
            if m.get("wide") or ratio > 2.0:
                item["wide"] = True
            elif m.get("tall") or ratio < 0.85:
                # 竖构图走竖位（3:4），与 4:3 横位并置
                item["tall"] = True

        out.append(item)
    return out


def main():
    audio = scan_audio()
    imgs = scan_img()

    manifest = {"audio": audio, "img": imgs}

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print("已写入 %s" % os.path.relpath(OUT, ROOT))
    print("  音频 %d 首：%s" % (len(audio), "、".join(a["title"] for a in audio) or "（空）"))
    print("  图片 %d 幅：%s" % (len(imgs), "、".join(i["file"] for i in imgs) or "（空）"))
    if not audio:
        print("  提示：把 mp3/m4a/wav 放进 assets/audio/ 再跑一次。")


if __name__ == "__main__":
    main()
