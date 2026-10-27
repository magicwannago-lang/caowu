# -*- coding: utf-8 -*-
r"""
Boss 通道一键诊断（Windows / macOS / Linux 通用）。

用法：
    python boss_diag.py

它会：
  1. 报告系统、Python、Playwright 版本与代理环境变量；
  2. 测试本机出口 IP（直连与系统代理两种）；
  3. 逐个用「直接启动 Chrome/Edge + CDP 连接」的方式打开 Boss 首页与登录页，
     抓取浏览器自身的 stderr 日志（Playwright 模式下这层日志看不到），
     判断是安全验证、页面关闭还是浏览器崩溃；
  4. 全过程写入同目录 boss-diag.log，截图 boss-diag-<browser>.png。

把 boss-diag.log 的内容发回即可定位。
"""
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from datetime import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import boss_browser as bb

try:
    from playwright.sync_api import sync_playwright
except Exception as e:
    print("[FATAL] 无法导入 playwright：", e)
    raise

HERE = os.path.dirname(os.path.abspath(__file__))
LOG_F = os.path.join(HERE, "boss-diag.log")
LINES = []


def log(msg=""):
    print(msg)
    LINES.append(str(msg))


def section(t):
    log("\n" + "=" * 64)
    log(t)
    log("=" * 64)


def http_get(url, use_proxy=True, timeout=10):
    handlers = [] if use_proxy else [urllib.request.ProxyHandler({})]
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8 caowu-diag"})
    with opener.open(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")[:300]


def find_browsers():
    """[(名称, exe 路径)]，去重。"""
    found = []
    seen = set()
    for p in bb._chrome_path_candidates():
        name = "edge" if ("Edge" in p or "msedge" in p.lower()) else "chrome"
        if p.lower() not in seen:
            seen.add(p.lower())
            found.append((name, p))
    if not found:
        # 手动再兜底（环境变量缺失时）
        guesses = []
        if sys.platform.startswith("win"):
            guesses = [
                ("chrome", r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
                ("edge", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
            ]
        for n, p in guesses:
            if os.path.exists(p) and p.lower() not in seen:
                found.append((n, p))
    return found


def win_system_proxy():
    if not sys.platform.startswith("win"):
        return "(非 Windows，跳过注册表代理检查)"
    try:
        out = subprocess.run(
            ["reg", "query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings"],
            capture_output=True, text=True, timeout=10).stdout
        keep = [ln.strip() for ln in out.splitlines()
                if "ProxyEnable" in ln or "ProxyServer" in ln or "AutoConfigURL" in ln]
        return "\n".join(keep) or "(未发现代理注册表项)"
    except Exception as e:
        return "(读取注册表失败：%s)" % e


def try_browser(name, exe, pw, report_dir):
    section("尝试浏览器：%s\n%s" % (name, exe))
    port = 9400 + (abs(hash(exe)) % 200)
    profile = os.path.join(report_dir, "diag-%s-profile" % name)
    err_f = os.path.join(report_dir, "diag-%s-stderr.log" % name)
    args = [
        exe,
        "--remote-debugging-port=%d" % port,
        "--remote-debugging-address=127.0.0.1",
        "--user-data-dir=%s" % profile,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
        "--disable-background-timer-throttling",
        "about:blank",
    ]
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        args.insert(1, "--no-sandbox")
    err = open(err_f, "wb")
    t0 = time.time()
    proc = subprocess.Popen(args, stdout=err, stderr=subprocess.STDOUT)
    result = {"name": name, "pid": proc.pid}
    try:
        endpoint = "http://127.0.0.1:%d/json/version" % port
        version_info = None
        for _ in range(30):
            if proc.poll() is not None:
                result["launch"] = "进程启动后立刻退出，退出码 %s" % proc.returncode
                return result
            try:
                version_info = json.loads(urllib.request.urlopen(endpoint, timeout=1).read())
                break
            except Exception:
                time.sleep(0.5)
        if not version_info:
            result["launch"] = "浏览器进程在但 CDP 端口未就绪（可能被安全软件拦截）"
            return result
        result["launch"] = "ok"
        result["browser"] = version_info.get("Browser", "?")
        log("CDP 就绪：%s（耗时 %.1fs）" % (result["browser"], time.time() - t0))

        browser = pw.chromium.connect_over_cdp("http://127.0.0.1:%d" % port)
        ctx = browser.contexts[0]
        page = ctx.new_page()
        crash = {"v": False}
        page.on("crash", lambda: crash.update(v=True))

        def visit(tag, url, wait=8):
            log("\n-- %s：%s" % (tag, url))
            try:
                resp = page.goto(url, wait_until="domcontentloaded", timeout=30000)
                log("HTTP %s" % (resp.status if resp else "?"))
            except Exception as e:
                log("goto 异常：%s: %s" % (type(e).__name__, str(e).splitlines()[0][:200]))
            page.wait_for_timeout(wait * 1000)
            try:
                final = page.url
                title = page.title()
            except Exception as e:
                final, title = "<page closed>", str(e)[:100]
            log("最终地址：%s\n标题：%s\npage.crashed=%s" % (final, title, crash["v"]))
            if "/web/passport/zp/verify" in final:
                log(">> 判定：安全验证页（出口 IP 被风控，常见于 VPN/代理/机房）")
            elif final.endswith("about:blank"):
                log(">> 判定：页面被重置为空白")
            return final

        visit("首页", bb.HOME_URL, 6)
        final = visit("登录页", bb.LOGIN_URL, 8)
        shot = os.path.join(HERE, "boss-diag-%s.png" % name)
        try:
            page.screenshot(path=shot)
            log("截图：%s" % shot)
        except Exception as e:
            log("截图失败：%s" % e)
        result["final"] = final
        try:
            browser.close()
        except Exception:
            pass
        return result
    finally:
        err.close()
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                if sys.platform.startswith("win"):
                    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                                   capture_output=True, timeout=10)
                else:
                    proc.kill()
            except Exception:
                pass
        time.sleep(1)
        log("\n浏览器 stderr 末尾 25 行（%s）：" % err_f)
        try:
            tail = open(err_f, "rb").read().decode("utf-8", "replace").splitlines()[-25:]
            for ln in tail:
                log("  " + ln[:240])
        except Exception as e:
            log("  (读取失败：%s)" % e)


def main():
    section("环境信息  %s" % datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    import platform
    try:
        import playwright
        pw_ver = getattr(playwright, "__version__", "?")
    except Exception:
        pw_ver = "?"
    log("OS：%s %s (%s)" % (platform.system(), platform.release(), platform.version()))
    log("Python：%s" % sys.version.split()[0])
    log("Playwright：%s" % pw_ver)
    log("可执行文件：%s" % sys.executable)
    log("Boss profile 目录：%s" % bb._profile_dir())

    section("代理环境变量")
    proxy_vars = {k: v for k, v in os.environ.items()
                  if "proxy" in k.lower() or k in ("BOSS_HEADFUL", "BOSS_CHROME_CHANNEL", "BOSS_CHROME_PATH")}
    log(json.dumps(proxy_vars, ensure_ascii=False, indent=2) if proxy_vars else "(无代理相关环境变量)")
    log("Windows 系统代理：\n" + win_system_proxy())

    section("出口 IP 测试")
    for label, use_proxy in (("跟随系统代理/VPN", True), ("强制直连(忽略系统代理)", False)):
        try:
            log("[%s] %s" % (label, http_get("https://myip.ipip.net", use_proxy=use_proxy).strip()))
        except Exception as e:
            log("[%s] 失败：%s" % (label, e))

    browsers = find_browsers()
    section("发现的浏览器：%d 个\n%s" % (
        len(browsers), "\n".join("%s -> %s" % (n, p) for n, p in browsers) or "(未找到 Chrome/Edge)"))
    if not browsers:
        log("请先安装 Chrome 或 Edge，或执行 python -m playwright install chromium")

    results = []
    with sync_playwright() as pw:
        with tempfile.TemporaryDirectory(prefix="boss-diag-") as td:
            for name, exe in browsers[:3]:
                try:
                    results.append(try_browser(name, exe, pw, td))
                except Exception as e:
                    results.append({"name": name, "fatal": "%s: %s" % (type(e).__name__, e)})

    section("结论汇总")
    for r in results:
        log(json.dumps(r, ensure_ascii=False))
    log("\n如所有浏览器都落在 verify 页：出口 IP 问题，请关 VPN/代理后再跑一次本脚本对比。")
    log("如浏览器「启动后立刻退出」：多为安全软件拦截或浏览器文件损坏，见上方 stderr。")

    with open(LOG_F, "w", encoding="utf-8") as f:
        f.write("\n".join(LINES))
    print("\n完整报告已写入：%s" % LOG_F)


if __name__ == "__main__":
    main()
