#!/usr/bin/env python3
"""把 vault-template 的心理问题总表与儒释道典籍同步为 Worker 内置知识库。

源：agent/vault-template/（独立仓库，已被本站 .gitignore 忽略）
目标：worker/src/knowledge/*.js（产物入库，Worker 部署只依赖产物）

改了知识库笔记后，重跑一次：python3 scripts/sync-knowledge.py
"""

import glob
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VAULT = os.path.join(ROOT, "agent", "vault-template")
OUT = os.path.join(ROOT, "worker", "src", "knowledge")

PSYCHOLOGY_SRC = os.path.join(VAULT, "心理问题", "现代人心理问题汇总.md")
CLASSICS_GLOB = os.path.join(VAULT, "儒释道典籍", "**", "*.md")


def js_string(text: str) -> str:
    return text.replace("\\", "\\\\").replace("`", "\\`").replace("${", "\\${")


def write_module(path: str, name: str, sections):
    """sections: [(标题, 正文)]，拼成一个导出模板字符串。"""
    parts = ["// 由 scripts/sync-knowledge.py 生成，勿手改。", f"export const {name} ="]
    body = []
    for title, text in sections:
        body.append(f"# {title}\n\n{text.strip()}")
    parts.append("`" + js_string("\n\n---\n\n".join(body)) + "`;")
    parts.append("")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(parts))


def main() -> int:
    if not os.path.isfile(PSYCHOLOGY_SRC):
        print(f"找不到 {PSYCHOLOGY_SRC}", file=sys.stderr)
        return 1

    os.makedirs(OUT, exist_ok=True)

    with open(PSYCHOLOGY_SRC, encoding="utf-8") as f:
        write_module(
            os.path.join(OUT, "psychology.js"),
            "psychology",
            [("现代人心理问题汇总", f.read())],
        )

    classics = []
    for path in sorted(glob.glob(CLASSICS_GLOB, recursive=True)):
        title = os.path.splitext(os.path.basename(path))[0]
        with open(path, encoding="utf-8") as f:
            classics.append((title, f.read()))

    if not classics:
        print("儒释道典籍目录下没有 .md 笔记", file=sys.stderr)
        return 1

    write_module(os.path.join(OUT, "classics.js"), "classics", classics)

    with open(os.path.join(OUT, "index.js"), "w", encoding="utf-8") as f:
        f.write(
            "// 由 scripts/sync-knowledge.py 生成，勿手改。\n"
            "export { psychology } from './psychology.js';\n"
            "export { classics } from './classics.js';\n"
        )

    print(f"已同步：心理问题 1 篇、典籍 {len(classics)} 篇 → {os.path.relpath(OUT, ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
