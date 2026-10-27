# -*- coding: utf-8 -*-
"""
Boss 直聘只读浏览器通道（Playwright sync_api）。

边界（刻意为之）：
- 只做三件事：持有扫码登录态、打开搜索页、读取岗位卡片 DOM。
- 本模块不含任何打招呼 / 发消息 / 投递动作；回复一律由用户本人在自己设备上完成。
- 低频拟人节奏：单次最多两页、翻页随机等待、服务端冷却，由 main.py 再兜一层锁。
- 撞到安全验证 / 滑块立即停手返回 blocked，不做任何绕过尝试。

所有 Playwright 调用必须发生在同一线程（sync_api 绑定线程），
main.py 用单线程 ThreadPoolExecutor 串行提交本模块函数。
"""

from __future__ import annotations

import os
import re
import sys
import time
import random
import shutil
import subprocess
import threading
import traceback
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from urllib.parse import quote

# playwright 为可选依赖：未安装时 /boss/status 返回 unsupported，不影响其他接口。
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


def _profile_dir() -> str:
    snap = any("/snap/" in p for p in _chrome_path_candidates())
    return SNAP_PROFILE_DIR if snap else PROFILE_DIR

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
CLOSED = "closed"          # 浏览器未启动
QR = "qr"                  # 已打开登录页，等待扫码确认
LOGGED_IN = "logged_in"    # 已登录
BLOCKED = "blocked"        # 撞到安全验证
ERROR = "error"            # 启动/页面异常

FETCH_PAGES = 2                 # 每次拉取最多页数
PAGE_DELAY = (6.0, 12.0)        # 翻页随机等待秒
COOLDOWN_SEC = 60               # 两次拉取冷却
NAV_TIMEOUT = 45000

# 二维码候选选择器（Boss 改版时在这里加/换，不必动业务代码）。
QR_SELECTORS = [
    ".qr-code-img img", ".qr-code-img", "img.qr-code-img",
    ".login-qrcode img", ".qrcode img", ".qr-img",
    ".sign-qr-code", ".scan-login .qr",
]

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
    """命中安全验证 / 滑块。"""


class BossClosed(Exception):
    """浏览器进程 / 页面已关闭，需要重新登录。"""


class BossError(Exception):
    pass


# 本轮进程内已证实不可用的浏览器启动方式（启动即崩等），自动换下一个。
_STRATEGY_FAILED: set = set()
ERROR_LOG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "boss-error.log")


def _strategy_key(strat: Dict[str, str]) -> str:
    return strat.get("channel") or strat.get("executable_path") or "bundled-chromium"


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
    """Windows：上一个浏览器崩了可能残留进程锁住 profile，按命令行里的
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
    saw_verify: bool = False  # 本次浏览器会话是否被下发过安全验证页
    _strategy_key: str = ""
    _pw: Any = None
    _browser: Any = None
    _ctx: Any = None
    _page: Any = None
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


# ===================== 浏览器生命周期 =====================
def _headful() -> bool:
    # 显式开关优先；桌面系统（Windows/Mac，或 Linux 有 DISPLAY）默认有头，
    # 有头更像真人浏览器、风控更松；无图形界面的 Linux 服务器才无头。
    env = os.environ.get("BOSS_HEADFUL", "").strip()
    if env:
        return env not in ("0", "false", "no")
    if sys.platform.startswith("win") or sys.platform == "darwin":
        return True
    return bool(os.environ.get("DISPLAY"))


# Playwright 自带 chromium 下载受限时，用系统 Chrome / Edge（个人电脑一般都有）。
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


def _launch_strategies() -> List[Dict[str, str]]:
    """浏览器启动候选：channel 优先（Playwright 认标准安装），再可执行路径，
    最后 Playwright 自带 chromium。"""
    strategies: List[Dict[str, str]] = []
    forced_channel = os.environ.get("BOSS_CHROME_CHANNEL", "").strip()
    if forced_channel:
        strategies.append({"channel": forced_channel})
    else:
        # Windows 先试标准安装的 Chrome / Edge（无需 playwright install）。
        if sys.platform.startswith("win") or sys.platform == "darwin":
            strategies += [{"channel": "chrome"}, {"channel": "msedge"}]
        for p in _chrome_path_candidates():
            strategies.append({"executable_path": p})
    strategies.append({})  # Playwright 自带 chromium
    return strategies


def alive() -> bool:
    """浏览器进程与页面还在（操作前自检，避免对着已关闭的上下文调用）。"""
    try:
        return session._ctx is not None and session._page is not None and not session._page.is_closed()
    except Exception:
        return False


def _launch():
    """启动持久化上下文；幂等。必须在专属线程调用。"""
    if sync_playwright is None:
        raise BossError("未安装 playwright：请在本机执行 pip install playwright 并 python -m playwright install chromium")
    if session._ctx is not None:
        if alive():
            return
        shutdown()  # 上下文已死（浏览器被关/崩溃），清干净再起
    profile_dir = _profile_dir()
    os.makedirs(profile_dir, exist_ok=True)
    session._pw = sync_playwright().start()
    args = [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        args.append("--no-sandbox")  # root 运行必须；本机单人服务，可接受。
    base_kw: Dict[str, Any] = dict(
        user_data_dir=profile_dir,
        headless=not _headful(),
        viewport={"width": 1280, "height": 860},
        locale="zh-CN",
        timezone_id="Asia/Shanghai",
        args=args,
    )
    errors: List[str] = []
    for strat in _launch_strategies():
        key = _strategy_key(strat)
        if key in _STRATEGY_FAILED:
            continue
        try:
            session._ctx = session._pw.chromium.launch_persistent_context(**base_kw, **strat)
            session._strategy_key = key
            break
        except Exception as e:
            _STRATEGY_FAILED.add(key)
            errors.append("%s: %s" % (key, str(e).splitlines()[0][:160]))
    if session._ctx is None:
        try:
            session._pw.stop()
        finally:
            session._pw = None
        raise BossError("没有可用的浏览器（请装 Chrome/Edge，或执行 python -m playwright install chromium）。尝试记录：%s"
                        % " | ".join(errors[-3:]))
    session._ctx.set_default_navigation_timeout(NAV_TIMEOUT)
    session._page = session._ctx.pages[0] if session._ctx.pages else session._ctx.new_page()
    session._page.on("framenavigated", _on_main_nav)


def _on_main_nav(frame) -> None:
    try:
        if frame == session._page.main_frame and "/web/passport/zp/verify" in (frame.url or ""):
            session.saw_verify = True
    except Exception:
        pass


def shutdown() -> None:
    if session._ctx is not None:
        try:
            session._ctx.close()
        except Exception:
            pass
    if session._pw is not None:
        try:
            session._pw.stop()
        except Exception:
            pass
    session._ctx = session._pw = session._page = None
    session.saw_verify = False
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


# ===================== 登录 / 二维码 =====================
def _cookies_dict() -> Dict[str, str]:
    return {c["name"]: c.get("value", "") for c in session._ctx.cookies()}


def _is_blocked(page) -> bool:
    url = page.url or ""
    if "/safe/" in url or "security-check" in url or "/web/passport/zp/verify" in url:
        return True
    if session.saw_verify:
        return True
    try:
        body = page.evaluate("() => document.body ? document.body.innerText.slice(0, 2000) : ''")
    except Exception:
        return False
    return any(w in body for w in ("安全验证", "滑块验证", "拖动下方滑块",
                                   "请完成验证码", "当前 IP 地址可能存在异常"))


def _logged_in_dom() -> bool:
    """首页 DOM 判定：登录后右上角是用户头像菜单，未登录是登录按钮。"""
    try:
        n = session._page.evaluate(
            """() => ({
                 user: !!document.querySelector('.nav-figure, .user-nav-wrap, .label-text.user-name'),
                 loginBtn: !!document.querySelector('.btn-outline-login, a[href*="/web/user"]')
               })"""
        )
        return bool(n.get("user")) and not n.get("loginBtn")
    except Exception:
        return False


def check_login() -> Dict[str, Any]:
    """轻量探测当前登录态，不强制跳转。"""
    if session._ctx is None:
        session.state = CLOSED
        return session.status()
    page = session._page
    url = page.url or ""
    cookies = _cookies_dict()
    has_wt2 = bool(cookies.get("wt2")) and len(cookies.get("wt2", "")) > 8
    # 扫码确认后登录页会自动跳走；仍在登录页则肯定未完成。
    if "/web/user" in url:
        session.state = QR
    elif has_wt2 and (url.startswith(HOME_URL) or "/web/geek" in url):
        if _logged_in_dom() or has_wt2:
            session.state = LOGGED_IN
            if not session.user:
                session.user = cookies.get("__zp_name__", "") or "Boss 账号"
    else:
        # 在其他页面：有 wt2 即视为登录态（DOM 判定作兜底）。
        session.state = LOGGED_IN if has_wt2 else QR
    return session.status()


def _open_login_once() -> str:
    """假定浏览器已启动：打开登录页并轮询判定，返回 qr/logged_in/blocked/timeout。
    浏览器中途崩溃会抛出异常（由 start_login 决定是否换浏览器重试）。"""
    session.saw_verify = False
    page = session._page
    page.goto(LOGIN_URL, wait_until="domcontentloaded")
    for _ in range(12):
        page.wait_for_timeout(1000)
        if not alive():
            raise BossClosed("浏览器窗口在打开登录页时被关闭")
        url = page.url or ""
        if url.endswith("about:blank"):
            return "blocked"
        if _is_blocked(page):
            return "blocked"
        if check_login()["state"] == LOGGED_IN:
            return "logged_in"
        if _find_qr() is not None:
            return "qr"
    return "timeout"


def start_login() -> Dict[str, Any]:
    with session._lock:
        if sync_playwright is None:
            session.state = ERROR
            session.message = "后端未安装 playwright"
            return session.status()

        blocked_once = False
        last_err = ""
        # Chrome 崩了自动换 Edge、再换可执行文件路径；每种只试一次。
        strategies = [s for s in _launch_strategies() if _strategy_key(s) not in _STRATEGY_FAILED]
        for strat in strategies:
            key = _strategy_key(strat)
            try:
                _launch()
                if not alive():
                    raise BossClosed("浏览器启动后立即退出")
                outcome = _open_login_once()
            except PWTimeout:
                outcome = "timeout"  # 导航超时但页面可能还在，让下一种浏览器试试
            except Exception as e:
                _log_exc("start_login[%s]" % key, e)
                last_err = "%s: %s" % (type(e).__name__, str(e).splitlines()[0][:120])
                _STRATEGY_FAILED.add(getattr(session, "_strategy_key", key) or key)
                shutdown()
                _kill_stray_browsers()
                continue

            if outcome == "logged_in":
                session.state = LOGGED_IN
                session.message = "登录态有效（%s）" % key
                return session.status()
            if outcome == "qr":
                session.state = QR
                session.message = "请用 Boss 直聘 App 扫码并在手机上确认登录（%s）" % key
                return session.status()
            if outcome == "blocked":
                # 风控按 IP，换浏览器无意义，直接告知。
                blocked_once = True
                break
            # timeout：换一种浏览器再试一次。
            _STRATEGY_FAILED.add(key)
            shutdown()
            _kill_stray_browsers()

        if blocked_once:
            session.state = BLOCKED
            session.message = ("Boss 要求安全验证或直接断开（机房 / 代理 / VPN 网络常见，家庭宽带一般不触发）。"
                               "请确认后端跑在本机常用网络；本工具不代解验证码。")
            return session.status()
        session.state = ERROR
        session.message = ("浏览器启动后随即关闭，Chrome/Edge/Chromium 都未能打开登录页。"
                           "详情见后端目录 boss-error.log；最后错误：%s") % last_err
        return session.status()


def _find_qr():
    for sel in QR_SELECTORS:
        try:
            loc = session._page.locator(sel).first
            if loc.count() and loc.is_visible():
                box = loc.bounding_box()
                if box and box["width"] >= 80 and box["height"] >= 80:
                    return loc
        except Exception:
            continue
    return None


def qr_png() -> Optional[bytes]:
    """截二维码元素；取不到时回退视口截图（登录页二维码居中，仍可扫）。"""
    if session._page is None:
        return None
    try:
        if session._page.is_closed():
            return None
        # 被风控弹走后会落在 about:blank，不能把白屏当二维码发出去。
        if (session._page.url or "").endswith("about:blank"):
            return None
    except Exception:
        return None
    page = session._page
    loc = _find_qr()
    if loc is not None:
        try:
            return loc.screenshot(timeout=4000)
        except Exception:
            pass
    try:
        return page.screenshot()
    except Exception:
        return None


# ===================== 岗位搜索（只读） =====================
def _parse_salary(s: str) -> tuple[float, float]:
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


def search_jobs(cfg: Dict[str, Any], resume: Dict[str, Any],
                existing_ids: Optional[set] = None) -> List[Dict[str, Any]]:
    """打开 1~FETCH_PAGES 搜索页读卡片（只读）。调用方持锁并已做冷却/忙碌判断。"""
    _launch()
    if not alive():
        raise BossClosed("浏览器已关闭，请重新扫码登录")
    page = session._page
    city = CITY_CODES.get((cfg.get("city") or "").strip(), 100010000)
    query = quote(cfg.get("targetPosition") or "")
    raw: List[Dict[str, Any]] = []
    for pno in range(1, FETCH_PAGES + 1):
        url = SEARCH_URL.format(q=query, city=city, page=pno)
        try:
            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_timeout(3500)
        except PWTimeout:
            pass
        if (page.url or "").endswith("about:blank") or _is_blocked(page):
            raise BossBlocked("搜索页要求安全验证或被断开（机房 / 代理 IP 常见），已停止；"
                              "本工具不处理验证码，请在家庭网络环境重试")
        try:
            page.wait_for_selector(".job-card-wrapper", timeout=15000)
        except PWTimeout:
            # 空结果页 .job-empty-wrapper，也算正常结束。
            if page.locator(".job-empty-wrapper").count():
                break
            if _is_blocked(page):
                raise BossBlocked("搜索页出现安全验证，已停止")
            if pno == 1:
                raise BossError("搜索页岗位列表未加载（可能未登录或页面结构变化）")
            break
        rows = page.evaluate(JOB_CARD_JS)
        if not rows:
            break
        raw.extend(rows)
        if pno < FETCH_PAGES:
            page.wait_for_timeout(int(random.uniform(*PAGE_DELAY) * 1000))

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
