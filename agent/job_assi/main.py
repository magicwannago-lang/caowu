from typing import List, Optional, Any, Dict
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from fastapi.responses import PlainTextResponse, Response

# Boss 直聘只读浏览器通道（可选依赖：未装 playwright 时 /boss/* 返回 unsupported，
# 不影响其余接口）。playwright sync_api 绑定线程，所有浏览器操作走单线程执行器串行。
try:
    import boss_browser
except Exception as _boss_import_err:  # pragma: no cover
    boss_browser = None

BOSS_EXEC = ThreadPoolExecutor(max_workers=1, thread_name_prefix="boss-browser")

app = FastAPI(title="JobAgent 招聘投递Agent后端", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # https 页面（GitHub Pages）访问本机 http://127.0.0.1:8000 时，Chrome 的
    # Private Network Access 预检要求后端放行并回
    # Access-Control-Allow-Private-Network: true，否则跨域被拦。
    allow_private_network=True,
)

# ===================== 内存存储（生产替换为数据库sqlite/postgres） =====================
class MemoryStore:
    llm_config: Dict[str, Any] = {
        "endpoint": "",
        "apiKey": "",
        "model": "gpt-4o-mini"
    }
    job_config: Dict[str, Any] = {
        "targetPosition": "后端开发工程师",
        "skills": ["Java", "Spring Boot", "MySQL"],
        "experienceYears": "3",
        "salaryMin": "18",
        "salaryMax": "30",
        "city": "北京",
        "jobType": "全职",
        "education": "本科",
        "industry": "互联网",
        "companySize": "",
        "notes": "期望技术氛围好、发展空间大",
        "blackCompanyList": []
    }
    resume_data: Dict[str, Any] = {
        "activeVid": "v1",
        "versions": [
            {
                "vid": "v1",
                "name": "默认简历",
                "content": "3年后端开发工程师，熟练Java SpringBoot MySQL Redis",
                "autoGenMsg": True,
                "templateMsg": "您好，我有多年后端开发经验，技能匹配贵司岗位，期待沟通。"
            }
        ]
    }
    sites: List[Dict[str, Any]] = [
        {
            "id": "demo-mock",
            "name": "示例招聘网(内置数据)",
            "type": "mock",
            "endpoint": "",
            "_cookie_encrypt": "",
            "enabled": True,
            "rateLimit": {
                "fetchIntervalMin": 10,
                "maxBatchSubmit": 5,
                "submitCoolDownSec": 30
            },
            "mapping": {
                "jobsPath": "",
                "titleKey": "title",
                "companyKey": "company",
                "cityKey": "city",
                "salaryKey": "salary",
                "jdKey": "jd"
            }
        }
    ]
    job_queue: List[Dict[str, Any]] = []
    submit_log: List[Dict[str, Any]] = []
    agent_status: Dict[str, Any] = {
        "fetch_running": False,
        "submit_running": False,
        "queue_wait_count": 0,
        "last_fetch_time": None
    }


store = MemoryStore()

# ===================== Pydantic Model =====================
class Resp(BaseModel):
    code: int = 0
    msg: str = "ok"
    data: Optional[Any] = None

class LLMConfigIn(BaseModel):
    endpoint: str
    apiKey: str
    model: str

class AnalyzeReq(BaseModel):
    current_config: Dict[str, Any]
    user_text: str

class JobConfigIn(BaseModel):
    targetPosition: str
    skills: List[str]
    experienceYears: str
    salaryMin: str
    salaryMax: str
    city: str
    jobType: str
    education: str
    industry: str
    companySize: str
    notes: str
    blackCompanyList: List[str]

class ResumeSaveIn(BaseModel):
    vid: str
    name: str
    content: str
    autoGenMsg: bool
    templateMsg: str

class ResumeActiveIn(BaseModel):
    vid: str

class SiteSaveIn(BaseModel):
    id: str
    name: str
    type: str
    endpoint: str
    cookie: str
    enabled: bool
    rateLimit: Dict[str, int]
    mapping: Dict[str, str]

class SiteToggleIn(BaseModel):
    siteId: str
    enabled: bool


class SiteTestIn(BaseModel):
    siteId: str

class JobApproveIn(BaseModel):
    jobId: str
    action: str
    customMsg: Optional[str] = ""
    resumeVid: str

class JobBatchApproveIn(BaseModel):
    items: List[JobApproveIn]

class QueuePauseIn(BaseModel):
    siteId: str
    pause: bool


# ===================== 工具函数 =====================
def wrap_response(data: Any, msg: str = "ok", code: int = 0) -> Resp:
    return Resp(code=code, msg=msg, data=data)

def filter_site_fields(site: Dict[str, Any]) -> Dict[str, Any]:
    s = site.copy()
    s.pop("_cookie_encrypt", None)
    s.pop("cookie", None)
    return s

# ===================== LLM 配置接口 =====================
@app.get("/api/v1/llm/config", response_model=Resp)
async def get_llm_config():
    return wrap_response(store.llm_config)

@app.post("/api/v1/llm/config", response_model=Resp)
async def save_llm_config(body: LLMConfigIn):
    store.llm_config["endpoint"] = body.endpoint
    store.llm_config["apiKey"] = body.apiKey
    store.llm_config["model"] = body.model
    return wrap_response(None, "LLM配置已保存")

@app.post("/api/v1/llm/test", response_model=Resp)
async def test_llm():
    return wrap_response({"ok": True, "echo": "连接成功"})

@app.post("/api/v1/llm/analyze_requirement", response_model=Resp)
async def analyze_requirement(body: AnalyzeReq):
    mock_config = body.current_config.copy()
    mock_reply = "已根据你的要求完善基础配置（模拟）"
    return wrap_response({"reply": mock_reply, "config": mock_config})

# ===================== 求职基础配置 =====================
@app.get("/api/v1/job/config", response_model=Resp)
async def get_job_config():
    return wrap_response(store.job_config)

@app.post("/api/v1/job/config", response_model=Resp)
async def save_job_config(body: JobConfigIn):
    store.job_config = body.model_dump()
    return wrap_response(None, "基础配置已保存")

# ===================== 简历版本管理 =====================
@app.get("/api/v1/resume/list", response_model=Resp)
async def resume_list():
    return wrap_response(store.resume_data)

@app.post("/api/v1/resume/save", response_model=Resp)
async def resume_save(body: ResumeSaveIn):
    lst = store.resume_data["versions"]
    idx = next((i for i, v in enumerate(lst) if v["vid"] == body.vid), -1)
    item = body.model_dump()
    if idx >= 0:
        lst[idx] = item
    else:
        lst.append(item)
    return wrap_response(None, "简历保存成功")

@app.post("/api/v1/resume/set_active", response_model=Resp)
async def resume_set_active(body: ResumeActiveIn):
    store.resume_data["activeVid"] = body.vid
    return wrap_response(None, "切换启用简历成功")

@app.delete("/api/v1/resume/{vid}", response_model=Resp)
async def resume_delete(vid: str):
    lst = store.resume_data["versions"]
    store.resume_data["versions"] = [v for v in lst if v["vid"] != vid]
    if store.resume_data["activeVid"] == vid and len(store.resume_data["versions"]) > 0:
        store.resume_data["activeVid"] = store.resume_data["versions"][0]["vid"]
    return wrap_response(None, "简历已删除")

# ===================== 招聘站点管理 =====================
@app.get("/api/v1/site/list", response_model=Resp)
async def site_list():
    res = [filter_site_fields(s) for s in store.sites]
    return wrap_response(res)

@app.post("/api/v1/site/save", response_model=Resp)
async def site_save(body: SiteSaveIn):
    item = body.model_dump()
    item["_cookie_encrypt"] = item.pop("cookie", "")
    idx = next((i for i, s in enumerate(store.sites) if s["id"] == item["id"]), -1)
    if idx >= 0:
        store.sites[idx] = item
    else:
        store.sites.append(item)
    return wrap_response(None, "站点保存成功")

@app.post("/api/v1/site/toggle", response_model=Resp)
async def site_toggle(body: SiteToggleIn):
    s = next((x for x in store.sites if x["id"] == body.siteId), None)
    if not s:
        raise HTTPException(status_code=404, detail="站点不存在")
    s["enabled"] = body.enabled
    return wrap_response(None, "站点状态切换成功")

@app.delete("/api/v1/site/{siteId}", response_model=Resp)
async def site_delete(siteId: str):
    store.sites = [x for x in store.sites if x["id"] != siteId]
    return wrap_response(None, "站点已删除")

@app.post("/api/v1/site/test", response_model=Resp)
async def site_test(body: SiteTestIn):
    siteId = body.siteId
    mock_jobs = [
        {
            "id": "j1",
            "title": "Java高级后端工程师",
            "company": "字节跳动",
            "city": "北京",
            "salary": "25‑40k",
            "experience": "3‑5年",
            "education": "本科",
            "skills": ["Java"],
            "tags": ["大厂"],
            "jd": "岗位描述示例"
        }
    ]
    return wrap_response({"ok": True, "jobs": mock_jobs, "message": "获取模拟岗位成功"})

# ===================== 岗位匹配 & 批复队列 =====================
@app.post("/api/v1/job/match", response_model=Resp)
async def job_match():
    mock_queue_item = {
        "jobId": "j1",
        "priority": "最符合",
        "score": 88,
        "reason": "技能匹配3/4；薪资区间重叠；城市匹配",
        "status": "pending",
        "customMsg": "",
        "submitAt": None,
        "submitResult": None,
        "job": {
            "id": "j1",
            "title": "Java高级后端工程师",
            "company": "字节跳动",
            "city": "北京",
            "salary": "25‑40k",
            "experience": "3‑5年",
            "education": "本科",
            "skills": ["Java", "Spring Boot", "MySQL", "Redis"],
            "tags": ["大厂", "技术氛围好"],
            "jd": "负责后端服务开发...",
            "source": "示例招聘网"
        }
    }
    store.job_queue = [mock_queue_item]
    store.agent_status["last_fetch_time"] = time.strftime("%Y-%m-%d %H:%M:%S")
    return wrap_response({"ok": True, "totalJobs": 1, "pendingCount": 1})

@app.get("/api/v1/job/queue", response_model=Resp)
async def get_job_queue():
    return wrap_response(store.job_queue)

@app.post("/api/v1/job/approve", response_model=Resp)
async def job_approve(body: JobApproveIn):
    item = next((x for x in store.job_queue if x["jobId"] == body.jobId), None)
    if not item:
        raise HTTPException(status_code=404, detail="岗位不存在")
    if body.action == "approve":
        item["status"] = "queue"
        item["customMsg"] = body.customMsg
    elif body.action == "reject":
        item["status"] = "rejected"
    else:
        raise HTTPException(status_code=400, detail="action非法")
    store.agent_status["queue_wait_count"] = len([x for x in store.job_queue if x["status"] == "queue"])
    return wrap_response(None, "批复完成")

@app.post("/api/v1/job/batch_approve", response_model=Resp)
async def job_batch_approve(body: JobBatchApproveIn):
    for sub in body.items:
        item = next((x for x in store.job_queue if x["jobId"] == sub.jobId), None)
        if not item:
            continue
        if sub.action == "approve":
            item["status"] = "queue"
            item["customMsg"] = sub.customMsg
        elif sub.action == "reject":
            item["status"] = "rejected"
    store.agent_status["queue_wait_count"] = len([x for x in store.job_queue if x["status"] == "queue"])
    return wrap_response(None, "批量批复完成")

@app.post("/api/v1/queue/pause", response_model=Resp)
async def queue_pause(body: QueuePauseIn):
    return wrap_response(None, f"站点 {body.siteId} 已设置 pause={body.pause}")

# ===================== 投递日志接口 =====================
@app.get("/api/v1/log/list", response_model=Resp)
async def log_list(page: int = 1, pageSize: int = 50):
    total = len(store.submit_log)
    return wrap_response({
        "total": total,
        "page": page,
        "pageSize": pageSize,
        "items": store.submit_log
    })

@app.get("/api/v1/log/export")
async def log_export():
    lines = ["时间,岗位,公司,来源站点,状态,投递消息"]
    for row in store.submit_log:
        line = f"{row.get('time','')},{row.get('title','')},{row.get('company','')},{row.get('source','')},{row.get('status','')},{row.get('msg','')}"
        lines.append(line)
    csv_text = "\n".join(lines)
    from urllib.parse import quote
    filename = quote("投递日志.csv")
    return PlainTextResponse(
        csv_text,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
    )

# ===================== Agent全局状态 =====================
@app.get("/api/v1/agent/status", response_model=Resp)
async def agent_status():
    store.agent_status["queue_wait_count"] = len([x for x in store.job_queue if x["status"] == "queue"])
    return wrap_response(store.agent_status)

@app.post("/api/v1/agent/stop", response_model=Resp)
async def agent_stop():
    store.agent_status["fetch_running"] = False
    store.agent_status["submit_running"] = False
    return wrap_response(None, "Agent已紧急停止")


# ===================== Boss 直聘（扫码登录 + 只读拉取，人工回复） =====================
def _boss_run(fn, *args, timeout: float = 170.0):
    """把浏览器操作提交到专属单线程执行器（playwright sync_api 不能跨线程）。"""
    return BOSS_EXEC.submit(fn, *args).result(timeout=timeout)


@app.get("/api/v1/boss/status", response_model=Resp)
async def boss_status():
    if boss_browser is None:
        return wrap_response({"state": "unsupported", "user": "", "message": "后端缺少 boss_browser 模块"},
                             msg="Boss 通道不可用", code=1)
    # 只读数据类字段，不必排队进浏览器线程，避免被长任务堵住状态轮询。
    return wrap_response(boss_browser.session.status())


@app.post("/api/v1/boss/login/start", response_model=Resp)
async def boss_login_start():
    # 登录阶段只拉起系统 Chrome/Edge（subprocess + 原生窗口），不需要 playwright；
    # playwright 仅在点「从 Boss 直聘拉取」读岗位时才需要。
    if boss_browser is None:
        return wrap_response(None, "后端缺少 boss_browser 模块，Boss 通道不可用", code=1)
    try:
        st = _boss_run(boss_browser.start_login)
        if st["state"] == "logged_in":
            msg = "登录态有效"
        elif st["state"] == "qr":
            msg = "已打开扫码登录页"
        else:
            msg = st.get("message") or "Boss 登录未就绪"
        return wrap_response(st, msg)
    except Exception as e:
        return wrap_response({"state": "error", "message": str(e)}, "Boss 登录启动失败：%s" % e, code=1)


@app.get("/api/v1/boss/qr.png")
async def boss_qr():
    if boss_browser is None:
        raise HTTPException(status_code=503, detail="boss channel unavailable")
    png = _boss_run(boss_browser.qr_png, timeout=30)
    if not png:
        raise HTTPException(status_code=404, detail="二维码尚未就绪，请稍后刷新")
    return Response(content=png, media_type="image/png",
                    headers={"Cache-Control": "no-store"})


@app.post("/api/v1/boss/logout", response_model=Resp)
async def boss_logout():
    if boss_browser is None:
        return wrap_response(None, "Boss 通道不可用", code=1)
    st = _boss_run(boss_browser.logout, timeout=30)
    return wrap_response(st, "已退出 Boss 登录")


@app.post("/api/v1/boss/match", response_model=Resp)
async def boss_match():
    if boss_browser is None or boss_browser.sync_playwright is None:
        return wrap_response(None, "后端未安装 playwright，Boss 通道不可用", code=1)
    sess = boss_browser.session

    if sess.busy:
        return wrap_response({"cooldownLeftSec": sess.status()["cooldownLeftSec"]}, "上一次拉取还在进行中", code=1)
    left = sess.status()["cooldownLeftSec"]
    if left > 0:
        return wrap_response({"cooldownLeftSec": left}, "拉取太频繁，请 %d 秒后再试" % left, code=1)
    is_alive = boss_browser.alive()
    if sess.state != boss_browser.LOGGED_IN or not is_alive:
        if not is_alive:
            boss_browser.shutdown()
        return wrap_response(
            {"state": sess.state if is_alive else "closed"},
            ("Boss 浏览器未运行或已关闭，请重新扫码登录" if not is_alive
             else "Boss 尚未登录，请先在「API/站点配置」页扫码登录"), code=1)

    cfg = store.job_config
    resume = next((v for v in store.resume_data["versions"]
                   if v["vid"] == store.resume_data["activeVid"]), None) or {}
    existing = {x["jobId"] for x in store.job_queue}

    def _run():
        sess.busy = True
        try:
            items = boss_browser.search_jobs(cfg, resume, existing)
            sess.last_match_at = time.time()
            sess.last_match_total = len(items)
            # 新结果置顶；旧 Boss 条目清除，其他来源（如内置示例）保留。
            store.job_queue = [x for x in store.job_queue
                               if (x.get("job") or {}).get("source") != "Boss直聘"] + items
            store.agent_status["last_fetch_time"] = time.strftime("%Y-%m-%d %H:%M:%S")
            return items
        finally:
            sess.busy = False

    try:
        items = _boss_run(_run, timeout=175)
    except boss_browser.BossClosed as e:
        boss_browser.shutdown()
        return wrap_response({"state": "closed"}, str(e), code=1)
    except boss_browser.BossBlocked as e:
        sess.state = boss_browser.BLOCKED
        sess.message = str(e)
        return wrap_response({"state": "blocked"}, str(e), code=2)
    except Exception as e:
        sess.state = boss_browser.ERROR
        sess.message = str(e)
        return wrap_response(None, "Boss 拉取失败：%s" % e, code=1)
    return wrap_response({"ok": True, "totalJobs": len(items),
                          "pendingCount": len([x for x in store.job_queue if x["status"] == "pending"])},
                         "本次拉取到 %d 个新岗位" % len(items))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
