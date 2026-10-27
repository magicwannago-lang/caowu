# -*- coding: utf-8 -*-
"""
Boss 直聘只读浏览器通道（原生窗口 + CDP 只读接入）。

为什么不用 Playwright 自己开页、自己跳转：
    实测（boss_diag.py 可复现）Boss 的页面 JS 能识别「由自动化代码创建标签页 /
    发起导航」——哪怕用了系统 Chrome + CDP 端口 + --disable-blink-features，
    Playwright 一 new_page / page.goto，登录页几秒内必被弹到安全验证页或
    about:blank；而同一个浏览器由系统命令启动、页面由浏览器自己原生打开时，
    登录页正常渲染、可正常扫码，与普通用户毫无二致。

因此本模块的分工是：
- 登录阶段：后端用 subprocess 直接拉起用户机器上的 Chrome/Edge（独立 profile，
  含 --remote-debugging-port），登录 URL 作为命令行参数由浏览器「自己打开」。
  此阶段不接入任何自动化客户端；用户在弹出的专用窗口里像平常一样扫码。
- 后台守护线程只通过调试端口的 HTTP /json 接口旁观标签页 URL（页面无法感知），
  据此判定 待扫码 / 已登录 / 安全验证 / 窗口被关。
- 拉取岗位阶段：新标签页同样由浏览器自己打开（HTTP /json/new 是浏览器级命令，
  不经页面 JS），标签加载完后才短暂接入 CDP，只读 DOM 卡片，随即断开。

边界（刻意为之）：
- 只做三件事：持有扫码登录态、打开搜索页、读取岗位卡片 DOM。
- 本模块不含任何打招呼 / 发消息 / 投递动作；回复一律由用户本人在自己设备上完成。
- 低频拟人节奏：单次最多两页、翻页随机等待、服务端冷却，由 main.py 再兜一层锁。
- 撞到安全验证 / 滑块立即停手返回 blocked，不做任何绕过尝试。

Playwright 调用绑定线程：sync_api 的 start/connect 只在 main.py 的单线程
BOSS_EXEC 中发生；守护线程只用 urllib，不碰 Playwright。
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import socket
import random
import shutil
import subprocess
import threading
import traceback
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

# playwright 为可选依赖：登录窗口本身不需要它（subprocess 即可），
# 仅在「拉取岗位读 DOM」时才必须；未安装时 /boss/match 返回明确提示。
try:
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout, Error as PWError
    try:  # 1.49+ 公开导出；1.64 仍在内部模块
        from playwright.sync_api import TargetClosedError as PWClosedError
    except Exception:
        from playwright._impl._errors import TargetClosedError as PWClosedError
except Exception:  # pragma: no cover
    sync_playwright = None
    PWTimeout = Exception
    PWError = Exception
    PWClosedError = Exception

# 登录 profile：默认仓库外隐藏目录；snap chromium 受 confinement 限制读不到
# $HOME 下的点开头目录，snap 版改放到其可写的 ~/snap/chromium/common 下。
PROFILE_DIR = os.path.expanduser("~/.caowu-jobassi/boss-profile")
SNAP_PROFILE_DIR = os.path.expanduser("~/snap/chromium/common/caowu-jobassi-profile")
# Windows 用户名含中文时，用户目录是非 ASCII 路径，部分 Chrome + 自动化组合
# 会在该路径下启动即关页；回落到全英文的 ProgramData 目录。
WIN_PROFILE_DIR = r"C:\ProgramData\caowu-jobassi\boss-profile"


def _is_ascii(p: str) -> bool:
    try:
        p.encode("ascii")
        return True
    except UnicodeEncodeError:
        return False


def _profile_dir() -> str:
    env = os.environ.get("BOSS_PROFILE_DIR", "").strip()
    if env:
        return env
    if any("/snap/" in p for p in _chrome_path_candidates()):
        return SNAP_PROFILE_DIR
    if sys.platform.startswith("win") and not _is_ascii(PROFILE_DIR):
        try:
            os.makedirs(WIN_PROFILE_DIR, exist_ok=True)
            test = os.path.join(WIN_PROFILE_DIR, ".wtest")
            with open(test, "w") as f:
                f.write("1")
            os.remove(test)
            return WIN_PROFILE_DIR
        except Exception:
            pass
    return PROFILE_DIR

LOGIN_URL = "https://www.zhipin.com/web/user/?ka=header-login"
HOME_URL = "https://www.zhipin.com/"
SEARCH_URL = "https://www.zhipin.com/web/geek/job?query={q}&city={city}&page={page}"

# 城市码小表（Boss 常见城市），未知城市回落全国。
CITY_CODES: Dict[str, int] = {
    "全国": 100010000, "不限": 100010000,
    "北京": 101010100, "上海": 101020100,
    "广州": 101280100, "深圳": 101280600,
    "杭州": 101210100, "成都": 101070100,
    "南京": 101190100, "武汉": 101200100,
    "西安": 101110100, "苏州": 101190400,
    "厦门": 101230200, "长沙": 101250100,
    "重庆": 101040100, "天津": 101030100,
    "青岛": 101120200, "郑州": 101180100,
}

# 状态
CLOSED = "closed"          # 浏览器未启动 / 窗口被关
QR = "qr"                  # 专用窗口已打开，等待用户在窗口里扫码
LOGGED_IN = "logged_in"    # 已登录
BLOCKED = "blocked"        # 撞到安全验证 / 系统层拦截
ERROR = "error"            # 启动/页面异常

FETCH_PAGES = 2                 # 每次拉取最多页数
PAGE_DELAY = (6.0, 12.0)        # 翻页随机等待秒
COOLDOWN_SEC = 60               # 两次拉取冷却
NAV_TIMEOUT = 45000

LOGIN_HINT = ("已弹出 Boss 专用浏览器窗口：请在窗口中切换到「扫码登录」，"
              "用 Boss App 扫码并在手机上确认；全程不要关闭该窗口。")

JOB_CARD_JS = r"""
() => Array.from(document.querySelectorAll('.job-card-wrapper')).map(el => {
  const txt = s => { const n = el.querySelector(s); return n ? n.innerText.trim() : ''; };
  const allTxt = s => Array.from(el.querySelectorAll(s)).map(n => n.innerText.trim()).filter(Boolean);
  const a = el.querySelector('a.job-card-left') || el.querySelector('a[href*="/job_detail/"]') || el.querySelector('a');
  return {
    title: txt('.job-name'),
    url: a ? a.href : '',
    area: txt('.job-area'),
    salary: txt('.salary'),
    jobTags: allTxt('.job-info .tag-list li'),
    skills: allTxt('.job-card-footer .tag-list li'),
    infoDesc: txt('.info-desc'),
    company: txt('.company-name a') || txt('.company-name'),
    companyTags: allTxt('.company-tag-list li'),
    hr: txt('.hr-name')
  };
});
"""


class BossBlocked(Exception):
    """命中安全验证 / 滑块 / 系统层拦截。"""


class BossClosed(Exception):
    """浏览器进程 / 窗口已关闭，需要重新扫码登录。"""


class BossError(Exception):
    pass


ERROR_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "boss-error.log")


def _log_exc(where: str, exc: BaseException) -> None:
    """浏览器异常落盘 boss-error.log（用户可回传）+ 控制台。"""
    line = "\n==== %s %s ====\n%s: %s\n%s" % (
        time.strftime("%Y-%m-%d %H:%M:%S"), where,
        type(exc).__name__, exc, traceback.format_exc())
    try:
        with open(ERROR_LOG, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass
    print(line, flush=True)


def _kill_stray_browsers() -> None:
    """Windows：上次的专用浏览器残留进程会锁住 profile，按命令行里的
    profile 名精准结束（绝不动用户日常的 Chrome / Edge 窗口）。"""
    if not sys.platform.startswith("win"):
        return
    ps = (
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' OR Name='msedge.exe'\" | "
        "Where-Object { $_.CommandLine -like '*caowu-jobassi*' } | "
        "Stop-Process -Force -ErrorAction SilentlyContinue"
    )
    try:
        subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                       timeout=20, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


@dataclass
class BossSession:
    state: str = CLOSED
    user: str = ""
    message: str = ""
    last_match_at: float = 0.0
    last_match_total: int = 0
    busy: bool = False
    _proc: Any = None
    _cdp_port: int = 0
    _watcher: Any = None
    _watch_stop: bool = False
    _pw: Any = None
    _pwbrowser: Any = None
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def status(self) -> Dict[str, Any]:
        left = max(0, int(COOLDOWN_SEC - (time.time() - self.last_match_at))) if self.last_match_at else 0
        return {
            "state": self.state,
            "user": self.user,
            "message": self.message,
            "busy": self.busy,
            "cooldownLeftSec": left,
            "cooldownSec": COOLDOWN_SEC,
        }


session = BossSession()


# ===================== 浏览器发现 =====================
def _headful() -> bool:
    # 显式开关优先；桌面系统（Windows/Mac，或 Linux 有 DISPLAY）默认有头，
    # 有头更像真人浏览器、风控更松；无图形界面的 Linux 服务器才无头。
    env = os.environ.get("BOSS_HEADFUL", "").strip()
    if env:
        return env not in ("0", "false", "no")
    if sys.platform.startswith("win") or sys.platform == "darwin":
        return True
    return bool(os.environ.get("DISPLAY"))


def _chrome_path_candidates() -> List[str]:
    """各平台常见安装路径，只返回实际存在者。"""
    env = os.environ.get("BOSS_CHROME_PATH", "").strip()
    if env:
        return [env]
    paths: List[str] = []
    if sys.platform.startswith("win"):
        pf = os.environ.get("ProgramFiles", r"C:\Program Files")
        pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
        local = os.environ.get("LOCALAPPDATA", "")
        paths += [
            os.path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
            os.path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
            os.path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
        ]
        if local:
            paths.append(os.path.join(local, "Google", "Chrome", "Application", "chrome.exe"))
    elif sys.platform == "darwin":
        paths += [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        ]
    else:
        paths += [
            "/snap/chromium/current/usr/lib/chromium-browser/chrome",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
        ]
    return [p for p in paths if os.path.exists(p)]


def _pick_exe() -> Optional[str]:
    forced_channel = os.environ.get("BOSS_CHROME_CHANNEL", "").strip().lower()
    cands = _chrome_path_candidates()
    if forced_channel == "msedge":
        for p in cands:
            if "edge" in p.lower():
                return p
    if forced_channel == "chrome":
        for p in cands:
            if "edge" not in p.lower():
                return p
    return cands[0] if cands else None


# ===================== 原生浏览器进程 + 调试端口 HTTP =====================
def _pick_port() -> int:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def _cdp_http(path: str, method: str = "GET", timeout: float = 3.0) -> Any:
    """调浏览器调试端口的 HTTP 接口（/json、/json/new、/json/close）。
    这是浏览器自身的本地服务，页面 JS 无法感知。"""
    url = "http://127.0.0.1:%d%s" % (session._cdp_port, path)
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read().decode("utf-8", "replace")
    return json.loads(raw) if raw else None


def _native_tabs() -> List[Dict[str, str]]:
    try:
        data = _cdp_http("/json", timeout=2)
        return [{"id": t.get("id", ""), "url": t.get("url", ""), "title": t.get("title", "")}
                for t in data if t.get("type") == "page"]
    except Exception:
        return []


def _native_new_tab(url: str) -> Dict[str, str]:
    """让浏览器自己开一个标签页（Chrome 111+ 要求 PUT，失败再试 GET）。"""
    q = quote(url, safe=":/?=&%")
    last = ""
    for method in ("PUT", "GET"):
        try:
            t = _cdp_http("/json/new?" + q, method=method, timeout=5)
            if t and t.get("id"):
                return {"id": t.get("id", ""), "url": t.get("url", url)}
        except Exception as e:
            last = str(e)[:120]
    raise BossError("无法让专用浏览器打开新标签（调试端口被限制？%s）" % last)


def _native_close_tab(tab_id: str) -> None:
    if not tab_id:
        return
    try:
        _cdp_http("/json/close/%s" % tab_id, timeout=3)
    except Exception:
        pass


def _build_cmd(exe: str, port: int, profile_dir: str, headless: bool, url: str) -> List[str]:
    args = [
        exe,
        "--remote-debugging-port=%d" % port,
        "--remote-debugging-address=127.0.0.1",
        "--user-data-dir=%s" % profile_dir,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
        "--window-size=1280,900",
        url,
    ]
    if headless:
        args.insert(1, "--headless=new")
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        args.insert(1, "--no-sandbox")  # root 运行必须；本机单人服务，可接受。
    return args


def alive() -> bool:
    """专用浏览器进程在、调试端口应答正常。"""
    proc = session._proc
    if proc is None or proc.poll() is not None:
        return False
    try:
        _cdp_http("/json/version", timeout=2)
        return True
    except Exception:
        return False


def shutdown() -> None:
    session._watch_stop = True
    if session._pwbrowser is not None:
        try:
            session._pwbrowser.close()  # 断开自动化连接，不杀浏览器
        except Exception:
            pass
    if session._pw is not None:
        try:
            session._pw.stop()
        except Exception:
            pass
    proc = session._proc
    if proc is not None:
        try:
            if sys.platform.startswith("win"):
                subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                               capture_output=True, timeout=10)
            else:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except Exception:
                    proc.kill()
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        # Linux snap 版 Chrome 的真实浏览器进程是 snap 包装器的子进程，
        # 父进程结束后可能残留并锁住 profile；按专用 profile 路径精确收尾。
        if not sys.platform.startswith("win") and not sys.platform == "darwin":
            try:
                subprocess.run(["pkill", "-f", "--user-data-dir=%s" % _profile_dir()],
                               capture_output=True, timeout=10)
                time.sleep(0.8)
            except Exception:
                pass
    session._proc = None
    session._cdp_port = 0
    session._pwbrowser = None
    session._pw = None
    session.state = CLOSED


def logout() -> Dict[str, Any]:
    with session._lock:
        profile_dir = _profile_dir()
        shutdown()
        if os.path.isdir(profile_dir):
            shutil.rmtree(profile_dir, ignore_errors=True)
        session.user = ""
        session.message = "已退出登录"
    return session.status()


# ===================== 登录：原生窗口 + 旁观守护线程 =====================
def _start_watcher() -> None:
    session._watch_stop = False

    def loop():
        blank_streak = 0
        while not session._watch_stop:
            time.sleep(1.5)
            proc = session._proc
            if proc is None or proc.poll() is not None:
                _set_state(CLOSED, "Boss 专用浏览器窗口已关闭，请重新扫码登录")
                return
            tabs = _native_tabs()
            zurls = [t["url"] for t in tabs if "zhipin.com" in t.get("url", "")]
            if any(u and ("/web/passport/zp/verify" in u or "/safe/" in u
                          or "security-check" in u) for u in zurls):
                _set_state(BLOCKED,
                           "Boss 在专用窗口里下发了安全验证页（VPN / 代理 / 异常 IP 时常见）。"
                           "请关掉 VPN、确认在家庭常用网络后重试；本工具不代解验证码。")
                return
            # 扫码确认后登录标签会离开 /web/user 跳到 Boss 首页/推荐页。
            if any(u and "/web/user" not in u and not u.endswith("about:blank")
                   for u in zurls):
                session.user = session.user or "Boss 账号"
                _set_state(LOGGED_IN, "扫码登录成功，专用浏览器保持登录态")
                return
            # 登录页被重置成空白或标签整个消失：多半是安全软件在系统层拦截。
            if zurls:
                blank_streak = 0
            else:
                blank_streak += 1
                if blank_streak >= 4:
                    _set_state(BLOCKED,
                               "专用窗口里的 Boss 页面被重置成空白/标签消失（常见于安全软件拦截）。"
                               "可在后端目录运行 python boss_diag.py 把 boss-diag.log 发回定位。")
                    return

    t = threading.Thread(target=loop, name="boss-login-watch", daemon=True)
    session._watcher = t
    t.start()


def _set_state(st: str, msg: str) -> None:
    session.state = st
    session.message = msg


def start_login() -> Dict[str, Any]:
    with session._lock:
        if alive():
            if session.state == LOGGED_IN:
                session.message = "登录态有效"
                return session.status()
            if session.state == QR:
                return session.status()  # 专用窗口已在等扫码，不重复拉起
            shutdown()
        else:
            shutdown()
        _kill_stray_browsers()

        exe = _pick_exe()
        if not exe:
            session.state = ERROR
            session.message = ("未找到 Chrome 或 Edge：请正常安装其一，"
                               "或设置 BOSS_CHROME_PATH 指向浏览器可执行文件。")
            return session.status()

        profile_dir = _profile_dir()
        os.makedirs(profile_dir, exist_ok=True)
        port = _pick_port()
        cmd = _build_cmd(exe, port, profile_dir, headless=not _headful(), url=LOGIN_URL)
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception as e:
            _log_exc("start_login.popen", e)
            session.state = ERROR
            session.message = "浏览器启动失败：%s" % str(e).splitlines()[0][:160]
            return session.status()

        session._proc = proc
        session._cdp_port = port

        # 等调试端口就绪（最多 20 秒）。
        ready = False
        for _ in range(40):
            if proc.poll() is not None:
                session.state = ERROR
                session.message = ("浏览器启动后立即退出（退出码 %s），多为安全软件拦截或配置目录损坏；"
                                   "详见 boss-error.log" % proc.returncode)
                shutdown()
                return session.status()
            try:
                _cdp_http("/json/version", timeout=1)
                ready = True
                break
            except Exception:
                time.sleep(0.5)
        if not ready:
            session.state = ERROR
            session.message = "浏览器已启动但调试端口未就绪（可能被安全软件拦截），详见 boss-error.log"
            shutdown()
            return session.status()

        # 再等登录标签自己加载出来（最多 10 秒），提前识别安全验证页。
        for _ in range(20):
            time.sleep(0.5)
            zurls = [t["url"] for t in _native_tabs() if "zhipin.com" in t.get("url", "")]
            if any("/web/passport/zp/verify" in u or "/safe/" in u for u in zurls):
                session.state = BLOCKED
                session.message = ("Boss 直接下发了安全验证页（VPN / 代理 / 异常 IP 时常见）。"
                                   "请关掉 VPN、确认在家庭常用网络后重试；本工具不代解验证码。")
                return session.status()
            if any("/web/user" in u for u in zurls):
                session.state = QR
                session.message = LOGIN_HINT
                _start_watcher()
                return session.status()

        session.state = ERROR
        session.message = "专用浏览器已打开，但登录页长时间未出现；可运行 python boss_diag.py 定位。"
        return session.status()


# ===================== CDP 只读接入（仅拉取岗位时） =====================
def _attach():
    """惰性连接 Playwright（只在 boss 单线程中调用），返回 CDP browser。"""
    if sync_playwright is None:
        raise BossError("后端未安装 playwright：请在本机执行 pip install playwright")
    if not alive():
        raise BossClosed("Boss 专用浏览器未运行或已关闭，请重新扫码登录")
    if session._pwbrowser is not None and session._pwbrowser.is_connected():
        return session._pwbrowser
    if session._pw is None:
        session._pw = sync_playwright().start()
    br = session._pw.chromium.connect_over_cdp("http://127.0.0.1:%d" % session._cdp_port)
    session._pwbrowser = br
    return br


def _attached_ctx():
    br = _attach()
    if not br.contexts:
        raise BossError("专用浏览器没有可用的上下文")
    return br.contexts[0]


def _detach() -> None:
    """断开 Playwright 连接但保留浏览器进程。每个搜索页读完即断，
    下一页让浏览器原生打开标签后再重新接入（对连接前已存在标签的枚举最可靠）。"""
    if session._pwbrowser is not None:
        try:
            session._pwbrowser.close()
        except Exception:
            pass
    session._pwbrowser = None


def _is_blocked(page) -> bool:
    url = page.url or ""
    if "/safe/" in url or "security-check" in url or "/web/passport/zp/verify" in url:
        return True
    if url.endswith("about:blank"):
        return True
    try:
        body = page.evaluate("() => document.body ? document.body.innerText.slice(0, 2000) : ''")
    except Exception:
        return False
    return any(w in body for w in ("安全验证", "滑块验证", "拖动下方滑块",
                                   "请完成验证码", "当前 IP 地址可能存在异常"))


def qr_png() -> Optional[bytes]:
    """原生窗口模式下二维码就在用户桌面弹出的专用窗口里，页面不再内嵌截图，
    以避免登录阶段挂着自动化连接。保留接口：未就绪时前端显示操作指引。"""
    return None


# ===================== 岗位搜索（只读） =====================
def _parse_salary(s: str) -> Tuple[float, float]:
    """'15-30K·14薪' -> (15, 30)；面议等返回 (0, 0)。"""
    m = re.search(r"(\d+(?:\.\d+)?)\s*[-~～]\s*(\d+(?:\.\d+)?)", s or "")
    if not m:
        return 0.0, 0.0
    return float(m.group(1)), float(m.group(2))


def _norm(s: str) -> str:
    return re.sub(r"[\s,，、/]+", "", (s or "").lower())


def filter_and_rank(raw: List[Dict[str, Any]], cfg: Dict[str, Any]) -> List[Dict[str, Any]]:
    black = [_norm(x) for x in (cfg.get("blackCompanyList") or []) if x]
    want_skills = [s for s in (cfg.get("skills") or []) if s]
    try:
        want_min = float(cfg.get("salaryMin") or 0)
    except ValueError:
        want_min = 0.0
    try:
        want_max = float(cfg.get("salaryMax") or 0)
    except ValueError:
        want_max = 0.0
    want_city = (cfg.get("city") or "").strip()

    out: List[Dict[str, Any]] = []
    for r in raw:
        company = r.get("company", "")
        if any(b and b in _norm(company) for b in black):
            continue
        jmin, jmax = _parse_salary(r.get("salary", ""))
        skill_hits = [s for s in want_skills if _norm(s) in _norm(" ".join(
            r.get("skills", []) + [r.get("infoDesc", "")] + r.get("jobTags", [])))]
        reasons: List[str] = []
        score = 60
        if want_skills:
            score += min(24, int(24 * len(skill_hits) / len(want_skills)))
            reasons.append("技能命中 %d/%d（%s）" % (len(skill_hits), len(want_skills),
                                                    "、".join(skill_hits) or "无明显标注"))
        if jmax and want_max:
            if jmax >= want_min and jmin <= want_max:
                score += 10
                reasons.append("薪资区间重叠")
            else:
                score -= 8
                reasons.append("薪资区间偏离期望")
        elif not jmax:
            reasons.append("薪资面议")
        if want_city and want_city not in ("全国", "不限"):
            if want_city in r.get("area", ""):
                score += 6
                reasons.append("城市匹配")
            else:
                score -= 6
        score = max(40, min(98, score))
        priority = "最符合" if score >= 85 else ("较符合" if score >= 70 else "一般符合")
        out.append({"raw": r, "score": score, "priority": priority, "reason": "；".join(reasons)})
    out.sort(key=lambda x: x["score"], reverse=True)
    return out


def build_greeting(job: Dict[str, Any], cfg: Dict[str, Any], resume: Dict[str, Any]) -> str:
    title = job.get("title") or cfg.get("targetPosition") or "该岗位"
    years = str(cfg.get("experienceYears") or "").strip()
    position = cfg.get("targetPosition") or "相关"
    skills = "、".join((cfg.get("skills") or [])[:3]) or "相关技术栈"
    tpl = (resume.get("templateMsg") or "").strip()
    if "{" in tpl and "}" in tpl:
        try:
            return tpl.format(title=title, years=years, position=position, skills=skills)
        except Exception:
            pass
    if tpl:
        return tpl
    y = ("%s 年" % years) if years else "多年"
    return ("您好，我有%s%s经验，熟悉%s，对贵司「%s」岗位很感兴趣，"
            "希望有机会进一步沟通。") % (y, position, skills, title)


def to_queue_item(ranked: Dict[str, Any], cfg: Dict[str, Any], resume: Dict[str, Any]) -> Dict[str, Any]:
    r = ranked["raw"]
    url = r.get("url", "")
    jid = url.rstrip("/").split("/")[-1].replace(".html", "") or ("boss_%d" % int(time.time() * 1000))
    job_tags = r.get("jobTags", [])  # 通常 [经验, 学历]
    skills = r.get("skills", [])
    job = {
        "id": jid,
        "title": r.get("title", ""),
        "company": r.get("company", ""),
        "city": r.get("area", ""),
        "salary": r.get("salary", ""),
        "experience": job_tags[0] if len(job_tags) > 0 else "",
        "education": job_tags[1] if len(job_tags) > 1 else "",
        "skills": skills,
        "tags": [t for t in r.get("companyTags", []) if t],
        "jd": r.get("infoDesc", ""),
        "hr": r.get("hr", ""),
        "source": "Boss直聘",
        "url": url,
    }
    greeting = build_greeting(job, cfg, resume)
    return {
        "jobId": "boss_" + jid,
        "priority": ranked["priority"],
        "score": ranked["score"],
        "reason": ranked["reason"],
        "status": "pending",
        "customMsg": greeting,
        "submitAt": None,
        "submitResult": None,
        "job": job,
    }


def _find_search_page(ctx, timeout_sec: float = 15.0):
    """在 CDP 已接入的页面集合里，等由浏览器原生打开的搜索标签出现。
    提前发现验证页/空白重置时抛 BossBlocked，不空等 15 秒。"""
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        try:
            for pg in ctx.pages:
                try:
                    u = pg.url or ""
                except Exception:
                    continue
                if "/web/geek/job" in u:
                    return pg, u
                if ("/web/passport/zp/verify" in u or "/safe/" in u
                        or "security-check" in u):
                    raise BossBlocked("搜索页被重定向到安全验证页（异常 IP 或风控常见），已停止；"
                                      "本工具不处理验证码，请稍后在常用网络重试")
        except BossBlocked:
            raise
        except Exception:
            pass
        time.sleep(0.5)
    return None, ""


def _read_one_search_page(url: str, check_login: bool) -> List[Dict[str, Any]]:
    """让浏览器原生开一个搜索标签 → 等它自己加载 → 接入只读卡片 → 关标签并断开。"""
    tab = _native_new_tab(url)
    page = None
    try:
        time.sleep(2.0)  # 关键：标签由浏览器自身打开并加载后，自动化再接入
        ctx = _attached_ctx()
        if check_login:
            try:
                cookies = {c["name"]: c.get("value", "") for c in ctx.cookies()}
            except Exception:
                cookies = {}
            if not (cookies.get("wt2") and len(cookies.get("wt2", "")) > 8):
                raise BossClosed("专用浏览器里没有登录态（wt2 缺失），请重新扫码登录")
            if cookies.get("__zp_name__"):
                session.user = cookies["__zp_name__"]

        page, _u = _find_search_page(ctx)
        if page is None:
            landed = [t.get("url", "") for t in _native_tabs()]
            if landed and all(("verify" in u) or ("/safe/" in u) or u.endswith("about:blank")
                              for u in landed if "zhipin.com" in u):
                raise BossBlocked("搜索页被重定向到安全验证 / 空白页（异常 IP 或风控常见），已停止；"
                                  "本工具不处理验证码，请稍后在常用网络重试")
            raise BossError("搜索标签已打开，但自动化侧未能读取到该标签")
        try:
            page.set_default_navigation_timeout(NAV_TIMEOUT)
        except Exception:
            pass
        page.wait_for_timeout(3500)  # 等异步岗位列表
        if _is_blocked(page):
            raise BossBlocked("搜索页要求安全验证或被重置空白，已停止；"
                              "本工具不处理验证码，请稍后在常用网络重试")
        try:
            page.wait_for_selector(".job-card-wrapper", timeout=15000)
        except PWTimeout:
            try:
                if page.locator(".job-empty-wrapper").count():
                    return []  # 空结果页
            except Exception:
                pass
            if _is_blocked(page):
                raise BossBlocked("搜索页出现安全验证，已停止")
            raise BossError("搜索页岗位列表未加载（可能登录已过期或页面结构变化）")
        return page.evaluate(JOB_CARD_JS) or []
    finally:
        if page is not None:
            try:
                page.close()  # Playwright 侧关标签
            except Exception:
                pass
        _native_close_tab(tab.get("id", ""))  # 兜底：浏览器侧也关
        _detach()


def search_jobs(cfg: Dict[str, Any], resume: Dict[str, Any],
                existing_ids: Optional[set] = None) -> List[Dict[str, Any]]:
    """让专用浏览器原生打开 1~FETCH_PAGES 个搜索页，每页接入后只读卡片 DOM。
    全程不由自动化发起任何页面跳转。调用方持锁并已做冷却/忙碌判断；本函数在 boss 单线程。"""
    if not alive():
        raise BossClosed("浏览器已关闭，请重新扫码登录")

    city = CITY_CODES.get((cfg.get("city") or "").strip(), 100010000)
    query = quote(cfg.get("targetPosition") or "")
    raw: List[Dict[str, Any]] = []
    for pno in range(1, FETCH_PAGES + 1):
        url = SEARCH_URL.format(q=query, city=city, page=pno)
        rows = _read_one_search_page(url, check_login=(pno == 1))
        if not rows:
            break  # 空结果或无卡片，后续页不必再翻
        raw.extend(rows)
        if pno < FETCH_PAGES:
            time.sleep(random.uniform(*PAGE_DELAY))

    ranked = filter_and_rank(raw, cfg)
    items: List[Dict[str, Any]] = []
    seen = existing_ids or set()
    for rk in ranked:
        item = to_queue_item(rk, cfg, resume)
        if item["jobId"] in seen:
            continue
        seen.add(item["jobId"])
        items.append(item)
    return items
