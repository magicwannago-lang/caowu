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


def ascii_tmp_base():
    """选一个全英文临时目录父级（Windows 用户名含中文时，默认 Temp 路径带中文，
    个别 Chrome 版本在该路径的独立 profile 下行为异常，统一排除这个干扰项）。"""
    if sys.platform.startswith("win"):
        for cand in (r"C:\ProgramData", os.environ.get("TEMP", ""), os.environ.get("TMP", "")):
            if cand and os.path.isdir(cand):
                try:
                    cand.encode("ascii")
                    return cand
                except UnicodeEncodeError:
                    continue
    return None


def hosts_check():
    """hosts 文件里是否有 zhipin 相关改写（某些加速器/流氓软件会写）。"""
    if not sys.platform.startswith("win"):
        return "(非 Windows，跳过 hosts 检查)"
    path = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                        "System32", "drivers", "etc", "hosts")
    try:
        raw = open(path, "rb").read().decode("utf-8", "replace")
    except Exception as e:
        return "(读取 hosts 失败：%s)" % e
    hits = [ln.strip() for ln in raw.splitlines()
            if "zhipin" in ln.lower() or "kanzhun" in ln.lower()]
    hits = [ln for ln in hits if not ln.lstrip().startswith("#")]
    return "\n".join(hits) if hits else "(hosts 中无 zhipin/看准 相关条目)"


def av_check():
    """Windows 安全中心登记的杀毒/安全软件名单（360/火绒/电脑管家会 hook 浏览器）。"""
    if not sys.platform.startswith("win"):
        return "(非 Windows，跳过)"
    ps = ("$names=@();"
          "foreach($ns in @('root/SecurityCenter2','root/SecurityCenter')){"
          " try { $names += (Get-CimInstance -Namespace $ns -ClassName AntiVirusProduct "
          "-ErrorAction SilentlyContinue | Select-Object -ExpandProperty displayName) } catch {} };"
          "($names | Sort-Object -Unique) -join ' | '")
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                             capture_output=True, text=True, timeout=20).stdout.strip()
        return out or "(安全中心未登记任何杀毒软件)"
    except Exception as e:
        return "(查询失败：%s)" % e


def unattached_test(exe, pw):
    """关键判别：启动 Chrome 打开 Boss 登录页，但全程不让 Playwright/CDP 客户端
    接管，只通过调试端口的 HTTP /json 接口旁观标签页 URL（页面无法感知这种查询）。
    - 不接管时页面正常停留：说明是「自动化接管被 Boss 的 JS 识别」。
    - 不接管仍被弹成 about:blank：说明是系统层（安全软件/hosts/网络）在动手。"""
    section("无接管直连测试（启动浏览器打开登录页，但不连接任何自动化客户端）\n%s" % exe)
    port = 9600 + (abs(hash(exe)) % 100)
    with tempfile.TemporaryDirectory(prefix="boss-diag-na-", dir=ascii_tmp_base()) as td:
        profile = os.path.join(td, "na-profile")
        args = [
            exe,
            "--remote-debugging-port=%d" % port,
            "--remote-debugging-address=127.0.0.1",
            "--user-data-dir=%s" % profile,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-timer-throttling",
            bb.LOGIN_URL,
        ]
        if not (sys.platform.startswith("win") or sys.platform == "darwin") and not os.environ.get("DISPLAY"):
            args.insert(1, "--headless=new")
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            args.insert(1, "--no-sandbox")
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        def peek():
            try:
                tabs = json.loads(urllib.request.urlopen(
                    "http://127.0.0.1:%d/json" % port, timeout=2).read())
                return [t.get("url", "") for t in tabs if t.get("type") == "page"]
            except Exception as e:
                return ["<查询失败: %s>" % str(e)[:80]]

        try:
            # 第 10 秒短暂接入一次：看登录页是否渲染出二维码，并观察「接入」这个动作
            # 本身是否触发页面弹走（接入前 URL 正常、接入后立刻空白 → 坐实检测点）。
            attach_at, attached = 10, False
            elapsed = 0
            for sec in (2, 4, 4, 4, 4, 4):  # 2/6/10/14/18/22s
                time.sleep(sec)
                elapsed += sec
                urls = peek()
                tag = ""
                if not attached and elapsed >= attach_at:
                    attached = True
                    tag = "  ← 此时短暂接入 Playwright 截图后立即断开"
                    try:
                        br = pw.chromium.connect_over_cdp("http://127.0.0.1:%d" % port)
                        c = br.contexts[0]
                        pg = next((x for x in c.pages if "zhipin" in (x.url or "")),
                                  c.pages[0] if c.pages else None)
                        if pg is None:
                            log("  接入后没有可操作的页面标签")
                        else:
                            log("  接入瞬间 url=%s title=%s" % (pg.url, (pg.title() or "")[:60]))
                            shot = os.path.join(HERE, "boss-diag-unattached.png")
                            pg.screenshot(path=shot)
                            log("  截图：%s（请人工查看：二维码 / 安全验证 / 空白）" % shot)
                        br.close()  # 仅断开连接，不杀浏览器
                    except Exception as e:
                        log("  接入截图失败：%s: %s" % (type(e).__name__, str(e)[:120]))
                log("t≈%2ds 标签页：%s%s" % (
                    elapsed, " | ".join(u[:110] for u in urls) or "(无页面标签)", tag))
        finally:
            try:
                if sys.platform.startswith("win"):
                    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                                   capture_output=True, timeout=10)
                else:
                    proc.terminate()
            except Exception:
                pass


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
    if not (sys.platform.startswith("win") or sys.platform == "darwin") and not os.environ.get("DISPLAY"):
        args.insert(1, "--headless=new")  # 无图形界面的 Linux
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
        events = []
        t_base = [time.time()]

        def on_nav(frame):
            try:
                if frame == page.main_frame:
                    events.append("+%.1fs %s" % (time.time() - t_base[0], (frame.url or "")[:120]))
            except Exception:
                pass
        page.on("framenavigated", on_nav)

        def visit(tag, url, wait=8):
            log("\n-- %s：%s" % (tag, url))
            del events[:]
            t_base[0] = time.time()
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
            log("主框架跳转链（%d 次）：" % len(events))
            for ev in events[:20]:
                log("   " + ev)
            if "/web/passport/zp/verify" in final:
                log(">> 判定：安全验证页（出口 IP 被风控，常见于 VPN/代理/机房）")
            elif final.endswith("about:blank"):
                log(">> 判定：页面被重置为空白")
            return final

        # 对照站：若百度也被弹成空白，说明是系统级拦截（安全软件等），与 Boss 无关。
        visit("对照站-百度", "https://www.baidu.com/", 4)
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
    import importlib.metadata
    import platform
    try:
        pw_ver = importlib.metadata.version("playwright")
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

    section("hosts / 安全软件检查")
    log("hosts：" + hosts_check())
    log("安全中心登记的杀毒软件：" + av_check())

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
    tmp_base = ascii_tmp_base()
    with sync_playwright() as pw:
        with tempfile.TemporaryDirectory(prefix="boss-diag-", dir=tmp_base) as td:
            for name, exe in browsers[:2]:
                try:
                    results.append(try_browser(name, exe, pw, td))
                except Exception as e:
                    results.append({"name": name, "fatal": "%s: %s" % (type(e).__name__, e)})
            # 接管测试结束后，用第一个浏览器做「不接管直连」对照（仅经 /json 旁观）。
            if browsers:
                try:
                    unattached_test(browsers[0][1], pw)
                except Exception as f:
                    log("无接管测试异常：%s: %s" % (type(f).__name__, f))

    section("结论指引（结合上面各项结果）")
    for r in results:
        log(json.dumps(r, ensure_ascii=False))
    log("\n判读规则：")
    log("1) 对照站百度也被弹成 about:blank → 系统层拦截（安全软件 hook/hosts/网络驱动），")
    log("   先临时退出上面列出的杀毒/安全软件再重跑。")
    log("2) 仅 Boss 弹走，且「无接管直连测试」里接入前 URL 正常、t=10s 一接入就弹走 →")
    log("   坐实 Boss 的 JS 识别自动化接管（看 boss-diag-unattached.png 接入前是否有二维码），")
    log("   由我们改登录流程：浏览器不接管，人工在专用窗口里扫码。")
    log("2b) 无接管时 URL 全程正常、截图也有二维码：日常人工登录完全可用。")
    log("3) 无接管时登录页仍被弹成 about:blank → 系统层或 IP 信誉（安全软件/路由器/劫持）。")
    log("4) 落在 verify.html：出口 IP 被风控（VPN/代理/机房），家庭宽带直连一般不触发。")
    log("5) 浏览器启动后立刻退出：安全软件拦截或浏览器文件损坏，见上方 stderr。")
    log("\n另外请务必手动对照一次：退出本脚本后，用你日常使用的 Chrome 直接打开")
    log(bb.LOGIN_URL)
    log("——日常浏览器能正常显示二维码，而本脚本各方式都空白，即可坐实「自动化被识别」。")

    with open(LOG_F, "w", encoding="utf-8") as f:
        f.write("\n".join(LINES))
    print("\n完整报告已写入：%s" % LOG_F)


if __name__ == "__main__":
    main()
