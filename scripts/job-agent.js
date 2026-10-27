/* ============================================================
   草屋 · 投递助手
   前端只做展示与人工批复；配置 / 简历 / 队列 / 日志全在后端
   （agent/job_assi/main.py，FastAPI 骨架，内存存储）。
   入内需口令：仅挡路人，不是真加密——静态页里没有真秘密，
   密钥与 Cookie 只提交给本机后端，不经此页落盘。
   ============================================================ */
(function () {
  'use strict';

  // ---- 口令（SHA-256 摘要，避免明文杵在源码里；客户端校验只作轻拦）----
  var PASS_SHA256 = '539ee749688c609440fab877fef829468a7a9f6f1aba3bab4460c644bd5b7b84';
  var UNLOCK_KEY = 'caowu:job-agent:unlocked';

  // ---- 后端地址：本机 FastAPI；换部署位置只改这里 ----
  var API_BASE = 'http://127.0.0.1:8000/api/v1';
  var HEADERS = { 'Content-Type': 'application/json' };

  var tab = 'chat';
  var busy = false;
  var siteForm = null;
  // Boss 直聘扫码登录轮询状态（不进 pageState，避免轮询刷整页）
  var bossUi = { timer: null, qrTimer: null, imgUrl: null, starting: false, cooldown: 0, greetCd: 0 };
  var CIRCLED = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'];
  var MAX_TEMPLATES = 9;
  var pageState = {
    llm: null,
    config: null,
    resume: null,
    templates: [],
    sites: [],
    queue: [],
    boss: null,
    submitLog: [],
    chat: [{
      role: 'assistant',
      text: '你好！我是招聘投递助手。\n1) 基础配置里可填最多 5 个目标岗位；\n2) 「简历&话术」里按序号维护打招呼话术模板；\n3) 扫码登录 Boss 后拉取真实在招岗位，在岗位卡上点 ①②③，即把对应话术发给 HR；\n4) 投递结果见投递日志。'
    }]
  };

  function setStatus(s) { document.getElementById('status').textContent = s; }
  function setBusy(b) { busy = b; }
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  /* ---------------- 通用 fetch ---------------- */
  async function apiGet(path) {
    var res = await fetch(API_BASE + path, { method: 'GET', headers: HEADERS });
    var json = await res.json();
    if (json.code !== 0) throw new Error(json.msg || '请求错误');
    return json.data;
  }
  async function apiPost(path, payload) {
    var res = await fetch(API_BASE + path, {
      method: 'POST', headers: HEADERS, body: JSON.stringify(payload || {})
    });
    var json = await res.json();
    if (json.code !== 0) throw new Error(json.msg || '请求错误');
    return json.data;
  }
  async function apiDelete(path) {
    var res = await fetch(API_BASE + path, { method: 'DELETE', headers: HEADERS });
    var json = await res.json();
    if (json.code !== 0) throw new Error(json.msg || '请求错误');
    return json.data;
  }

  /* ---------------- 初始化与刷新 ---------------- */
  async function initLoad() {
    try {
      setStatus('加载配置…');
      pageState.llm = await apiGet('/llm/config');
      pageState.config = await apiGet('/job/config');
      pageState.resume = await apiGet('/resume/list');
      try { pageState.templates = (await apiGet('/template/list')) || []; }
      catch (e) { pageState.templates = []; }  // 旧后端没有此接口时不拖垮整页
      pageState.sites = await apiGet('/site/list');
      pageState.queue = await apiGet('/job/queue');
      var logWrap = await apiGet('/log/list?page=1&pageSize=100');
      pageState.submitLog = logWrap.items || [];
      setStatus('就绪');
    } catch (e) {
      // 公网 https 页连本机 http 后端时，Chrome 会先弹「允许访问本机设备/其他应用」
      // 许可框：首次请求在授权前失败属正常，点允许后刷新即可。
      var permHint = location.protocol === 'https:'
        ? '若浏览器刚询问是否允许访问本机设备，请点「允许」后刷新；' : '';
      setStatus('后端连不上：' + permHint + '也请确认本机已运行 agent/job_assi/main.py');
      console.error(e);
    }
    // Boss 通道独立探测：不可用不影响其余五个 Tab。
    try {
      pageState.boss = await apiGet('/boss/status');
      if (pageState.boss && pageState.boss.cooldownLeftSec > 0) bossUi.cooldown = pageState.boss.cooldownLeftSec;
      if (pageState.boss && pageState.boss.greetCooldownLeftSec > 0) bossUi.greetCd = pageState.boss.greetCooldownLeftSec;
    } catch (e) {
      pageState.boss = { state: 'unsupported', message: '后端版本过旧或未装 playwright' };
    }
    if (pageState.boss && pageState.boss.state === 'qr') startBossQrPolling();
    render();
  }

  /* ---------------- 渲染分发 ---------------- */
  function render() {
    var main = $('main');
    if (tab === 'chat') main.innerHTML = viewChat();
    else if (tab === 'config') main.innerHTML = viewConfig();
    else if (tab === 'resume') main.innerHTML = viewResume();
    else if (tab === 'match') main.innerHTML = viewMatch();
    else if (tab === 'log') main.innerHTML = viewLog();
    else main.innerHTML = viewApi();
    bind();
  }

  function viewChat() {
    var msgs = pageState.chat.map(function (m) {
      return '<div class="bub ' + (m.role === 'user' ? 'u' : 'a') + '">' + esc(m.text) + '</div>';
    }).join('');
    return '<div class="msgs" id="msgs">' + msgs + '</div>' +
      '<div class="composer">' +
      '<textarea id="input" placeholder="输入应聘要求，如：3年后端经验，熟悉 Java，期望 20-30k，北京&#10;Enter 发送，Shift+Enter 换行"></textarea>' +
      '<button class="btn" id="sendBtn" ' + (busy ? 'disabled' : '') + '>' +
      (busy ? '<span class="spin"></span>' : '发送') + '</button>' +
      '</div>' +
      '<div class="tt" style="margin-top:10px">由后端 Agent 解析要求并回写基础配置</div>';
  }

  function viewConfig() {
    var c = pageState.config || {};
    // 目标岗位最多 5 个：旧数据 targetPosition 单值自动并入第一格。
    var positions = (c.targetPositions || []).slice(0, 5);
    if (!positions.length && c.targetPosition) positions = [c.targetPosition];
    while (positions.length < 5) positions.push('');
    var posHtml = positions.map(function (p, i) {
      return '<div class="pos-row"><span class="pos-seq">' + CIRCLED[i] + '</span>' +
        '<input data-cfg="targetPositions" value="' + esc(p) + '" placeholder="岗位 ' + (i + 1) +
        (i === 0 ? '（建议填写）' : '（可留空）') + '"></div>';
    }).join('');
    function fld(k, label, ph) {
      return '<div class="fld"><label>' + label + '</label>' +
        '<input data-cfg="' + k + '" value="' + esc(c[k] != null ? c[k] : '') + '" placeholder="' + ph + '"></div>';
    }
    return '<div class="card"><h3>基础配置（应聘要求）</h3>' +
      '<div class="fld"><label>目标岗位（最多 5 个，将分别到 Boss 检索真实岗位）</label>' + posHtml + '</div>' +
      '<div class="fld"><label>核心技能（逗号分隔）</label>' +
      '<input data-cfg="skills" value="' + esc((c.skills || []).join(', ')) + '" placeholder="Java, Spring Boot, MySQL"></div>' +
      '<div class="row">' + fld('experienceYears', '工作年限', '如 3') + fld('education', '学历', '如 本科') + '</div>' +
      '<div class="row">' + fld('salaryMin', '期望薪资下限(k)', '如 18') + fld('salaryMax', '期望薪资上限(k)', '如 30') + '</div>' +
      '<div class="row">' + fld('city', '城市', '如 北京') + fld('jobType', '求职类型', '全职/兼职/实习') + '</div>' +
      '<div class="row">' + fld('industry', '行业', '如 互联网') + fld('companySize', '公司规模', '如 不限') + '</div>' +
      '<div class="fld"><label>黑名单公司（逗号分隔，命中直接过滤）</label>' +
      '<input data-cfg="blackCompanyList" value="' + esc((c.blackCompanyList || []).join(', ')) + '" placeholder="公司A,公司B"></div>' +
      '<div class="fld"><label>其他要求</label>' +
      '<textarea data-cfg="notes" placeholder="发展空间、技术氛围等">' + esc(c.notes || '') + '</textarea></div>' +
      '<button class="btn" id="saveCfgBtn">保存基础配置</button>' +
      '</div>';
  }

  function viewResume() {
    var res = pageState.resume || { activeVid: '', versions: [] };
    var active = res.versions.find(function (v) { return v.vid === res.activeVid; }) || res.versions[0];
    var listHtml = res.versions.map(function (v) {
      return '<div class="card"><div class="site">' +
        '<span class="sname">' + esc(v.name) + '</span>' +
        (v.vid === res.activeVid ? '<span class="badge b-ok">当前启用</span>' : '') +
        '<button class="ico-btn" data-edit-resume="' + v.vid + '" title="编辑">✎</button>' +
        '<button class="ico-btn" data-setactive="' + v.vid + '" title="设为启用">▶</button>' +
        (res.versions.length > 1 ? '<button class="ico-btn" data-del-resume="' + v.vid + '" title="删除">🗑</button>' : '') +
        '</div>' +
        '<div class="tt">简历内容预览：' + esc((v.content || '').slice(0, 60)) + '…</div>' +
        '</div>';
    }).join('');
    var editFormHtml = active ?
      '<div class="card"><h3>编辑简历版本</h3>' +
      '<div class="fld"><label>版本名称</label><input id="resume_name" value="' + esc(active.name) + '"></div>' +
      '<div class="fld"><label>简历正文</label><textarea id="resume_content">' + esc(active.content) + '</textarea></div>' +
      '<div class="fld"><label>默认自荐模板</label><textarea id="resume_template">' + esc(active.templateMsg) + '</textarea></div>' +
      '<div class="fld"><label class="check-line">' +
      '<input type="checkbox" id="resume_autogen" style="width:auto;margin-right:7px" ' + (active.autoGenMsg ? 'checked' : '') + '>' +
      '允许 AI 根据 JD 动态改写自荐话术</label></div>' +
      '<div class="seg"><button class="btn" id="saveResumeBtn">保存简历</button>' +
      '<button class="btn ghost" id="cancelResumeBtn">取消</button></div>' +
      '</div>' : '';
    return '<div class="warn-note">简历用于自荐背景；话术模板按序号管理，岗位卡片上点 ①②③ 即取对应模板发送给 HR。</div>' +
      '<div class="card"><h3>简历版本管理</h3><button class="btn sm" id="addResumeBtn">＋新增简历版本</button></div>' +
      listHtml + editFormHtml + viewTemplates();
  }

  function viewTemplates() {
    var tpls = pageState.templates || [];
    var rows = tpls.map(function (t, i) {
      return '<div class="card tpl-card"><div class="tpl-head">' +
        '<span class="tpl-seq">' + CIRCLED[i] + '</span>' +
        '<input class="tpl-name" data-tpl-name="' + t.tid + '" value="' + esc(t.name) + '" placeholder="模板名称（如 通用自荐）"></div>' +
        '<textarea rows="3" data-tpl-content="' + t.tid + '" placeholder="话术内容，支持占位符 {title} {years} {position} {skills}">' +
        esc(t.content || '') + '</textarea>' +
        '<div class="seg"><button class="btn sm" data-tpl-save="' + t.tid + '">保存话术 ' + (i + 1) + '</button>' +
        (tpls.length > 1 ? '<button class="btn bad sm" data-tpl-del="' + t.tid + '">删除</button>' : '') +
        '<span class="tt" style="margin:0 0 0 4px">岗位卡上的 ' + CIRCLED[i] + ' 按钮即发此条</span></div></div>';
    }).join('');
    var add = tpls.length < MAX_TEMPLATES
      ? '<button class="btn sm" id="addTplBtn">＋新增话术模板</button>'
      : '<span class="tt" style="margin:0">最多 ' + MAX_TEMPLATES + ' 条</span>';
    return '<div class="card"><h3>话术模板（序号管理）</h3>' +
      '<p class="tt" style="margin:0 0 2px">每条模板固定对应一个序号；在「职位筛选批复」的岗位卡上点序号，即把该话术填入 Boss 沟通框并发送。</p>' +
      '<p class="tt" style="margin:0">可用占位符：{title} 岗位名、{years} 年限、{position} 求职方向、{skills} 技能，发送时自动替换。</p></div>' +
      rows + '<div class="card" style="display:flex;align-items:center;gap:12px">' + add + '</div>';
  }

  function bossLoggedIn() {
    return !!(pageState.boss && pageState.boss.state === 'logged_in');
  }

  // 职位筛选只走真实招聘站（Boss 直聘）；未登录时引导去扫码。
  function bossMatchBtns() {
    var b = pageState.boss;
    if (b && b.state === 'logged_in') {
      var cd = bossUi.cooldown > 0;
      var wait = busy || b.busy;
      var label = wait ? '拉取中…' : (cd ? '拉取冷却中 ' + bossUi.cooldown + ' 秒' : '从 Boss 直聘拉取岗位');
      return '<button class="btn" id="bossMatchBtn"' + ((wait || cd) ? ' disabled' : '') + '>' + label + '</button>';
    }
    return '<button class="btn" disabled>从 Boss 直聘拉取岗位</button>' +
      '<button class="btn ghost sm" id="goLoginBtn">去扫码登录 ↗</button>';
  }

  function viewMatch() {
    var q = pageState.queue || [];
    if (q.length === 0) {
      var hint = bossLoggedIn()
        ? '点「从 Boss 直聘拉取岗位」，将按基础配置里的最多 5 个目标岗位分别检索真实在招岗位并打分；\n在岗位卡上点 ①②③，即以对应话术模板直接向 HR 发送招呼。'
        : '先到「API/站点配置」扫码登录 Boss 直聘，登录后即可拉取真实岗位。';
      return '<div class="card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">' +
        bossMatchBtns() + '</div><div class="hint" style="white-space:pre-line">' + hint + '</div>';
    }
    var stats = {
      total: q.length,
      pending: q.filter(function (x) { return x.status === 'pending'; }).length,
      queue: q.filter(function (x) { return x.status === 'queue'; }).length,
      success: q.filter(function (x) { return x.status === 'success'; }).length,
      reject: q.filter(function (x) { return x.status === 'rejected'; }).length
    };
    var P = [['最符合', 'pbest'], ['较符合', 'pgood'], ['一般符合', 'pavg']];
    var heads = '', cols = '';
    P.forEach(function (p) {
      var items = q.filter(function (it) { return it.priority === p[0]; });
      heads += '<div class="pcol"><div class="phead"><span class="dot ' + p[1] + '"></span>' +
        p[0] + ' <span class="pcnt">' + items.length + '</span></div></div>';
      cols += '<div class="pcol">' + items.map(jobCard).join('') + '</div>';
    });
    return '<div class="card" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
      bossMatchBtns() +
      '<span class="tt" style="margin:0">共 ' + stats.total + '｜待批复 ' + stats.pending +
      '｜待回复 ' + stats.queue + '｜投递成功 ' + stats.success + '｜已跳过 ' + stats.reject + '</span>' +
      '</div>' + heads + cols;
  }

  function jobCard(it) {
    var j = it.job || {};
    var st = it.status || 'pending';
    var isBoss = j.source === 'Boss直聘';
    var badgeTxt = '';
    if (st === 'pending') badgeTxt = '<span class="badge b-warn">待批复</span>';
    else if (st === 'queue') badgeTxt = '<span class="badge b-warn">' + (isBoss ? '待你回复' : '已批准，待投递') + '</span>';
    else if (st === 'success') badgeTxt = '<span class="badge b-ok">投递成功</span>';
    else if (st === 'fail') badgeTxt = '<span class="badge b-bad">投递失败</span>';
    else if (st === 'rejected') badgeTxt = '<span class="badge b-bad">' + (isBoss ? '已跳过' : '已驳回') + '</span>';

    var actsHtml = '';
    if (isBoss && st !== 'success') {
      // 点话术序号 → 后端在专用浏览器里打开沟通框、填该模板并发送（逐条、有冷却）。
      var tpls = pageState.templates || [];
      var sendBtns = tpls.map(function (t, i) {
        return '<button class="btn ok sm tpl-send" data-greet="' + it.jobId + '" data-tpl="' + t.tid + '" ' +
          'title="用话术 ' + (i + 1) + '「' + esc(t.name || '') + '」向 HR 发送招呼">' + CIRCLED[i] + '</button>';
      }).join('');
      actsHtml = sendBtns +
        '<button class="btn ghost sm" data-copy="' + it.jobId + '">复制话术</button>' +
        (st === 'pending' ? '<button class="btn bad sm" data-reject="' + it.jobId + '">跳过</button>' : '');
    } else if (st === 'pending') {
      actsHtml =
        '<button class="btn ok sm" data-approve="' + it.jobId + '">批准入投递队列</button>' +
        '<button class="btn bad sm" data-reject="' + it.jobId + '">驳回</button>' +
        '<button class="btn ghost sm" data-editmsg="' + it.jobId + '">编辑本次自荐语</button>';
    }
    var jdHtml = j.jd ? '<div style="margin:6px 0"><button class="btn ghost sm" data-togglejd="' + it.jobId +
      '">展开 / 收起 JD</button><div id="jd_' + it.jobId + '" class="expand-block" style="display:none">' +
      esc(j.jd) + '</div></div>' : '';
    var customMsgHtml = it.customMsg
      ? '<div class="tt msg-box">招呼话术：' + esc(it.customMsg) + '</div>' : '';

    var titleLine = j.url
      ? '<a class="jt jt-link" href="' + esc(j.url) + '" target="_blank" rel="noopener" title="在 Boss 中打开岗位">' +
        esc(j.title || '') + ' · ' + esc(j.company || '') + ' ↗</a>'
      : '<div class="jt">' + esc(j.title || '') + ' · ' + esc(j.company || '') + '</div>';
    return '<div class="job ' + st + '">' + titleLine +
      '<div class="jm">' + [j.city, j.salary, j.experience, j.education, j.source].filter(Boolean).map(esc).join(' / ') + '</div>' +
      '<div class="jsc">匹配度 ' + (it.score || 0) + ' · ' + esc(it.priority || '') + '</div>' +
      '<div class="jr">' + esc(it.reason || '') + '</div>' +
      (j.skills || []).map(function (s) { return '<span class="chip">' + esc(s) + '</span>'; }).join('') +
      jdHtml + customMsgHtml +
      '<div class="jact" style="margin-top:9px">' + badgeTxt + '<span style="flex:1"></span>' + actsHtml + '</div>' +
      '</div>';
  }

  function viewLog() {
    var logs = pageState.submitLog || [];
    if (logs.length === 0) {
      return '<div class="empty">暂无投递记录</div>' +
        '<div class="card"><button class="btn sm" id="exportLogBtn">导出 CSV</button></div>';
    }
    var rows = logs.map(function (l) {
      return '<tr><td>' + esc(l.time || '') + '</td><td>' + esc(l.title || '') + '</td>' +
        '<td>' + esc(l.company || '') + '</td><td>' + esc(l.source || '') + '</td>' +
        '<td>' + esc(l.status || '') + '</td><td>' + esc(l.msg || '') + '</td></tr>';
    }).join('');
    return '<div class="card"><h3>投递历史记录</h3><button class="btn sm" id="exportLogBtn">导出 CSV</button></div>' +
      '<div class="card" style="overflow:auto"><table class="log-table">' +
      '<thead><tr><th>时间</th><th>岗位</th><th>公司</th><th>来源站点</th><th>状态</th><th>投递消息</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  function bossStateText(b) {
    switch (b.state) {
      case 'logged_in': return '已登录' + (b.user ? '：' + b.user : '');
      case 'qr': return b.message || '请用 Boss 直聘 App 扫码，并在手机上确认登录';
      case 'blocked': return b.message || '遇到安全验证，本工具不处理验证码，请稍后再试';
      case 'error': return b.message || '通道异常';
      case 'unsupported': return b.message || '后端未安装 playwright，Boss 通道不可用';
      case 'closed':
      default: return '未登录。扫码后登录态只保存在本机后端的浏览器配置中。';
    }
  }

  function viewBossCard() {
    var b = pageState.boss || { state: 'closed' };
    var dotCls = b.state === 'logged_in' ? 'dot pbest'
      : (b.state === 'qr' ? 'dot pgood' : (b.state === 'blocked' || b.state === 'error' ? 'dot pavg' : 'dot'));
    var body;
    if (b.state === 'logged_in') {
      body = '<div class="boss-row"><span class="' + dotCls + '"></span><span class="tt" style="margin:0">Boss 直聘已连接' +
        (b.user ? '（' + esc(b.user) + '）' : '') + '</span><span style="flex:1"></span>' +
        '<button class="btn ghost sm" id="bossLogoutBtn">退出登录</button></div>' +
        '<p class="tt">每次拉取最多两页、间隔一分钟以上；助手只读公开岗位，所有招呼由你本人在 Boss 里发送。</p>';
    } else {
      var qrBox = b.state === 'qr'
        ? '<div class="boss-qr boss-qr-steps">' +
          '<div class="qrstep"><b>①</b> 找到新弹出的「Boss 专用浏览器」窗口（标题为 Boss 直聘）</div>' +
          '<div class="qrstep"><b>②</b> 若窗口停在手机号验证页，点页面右上角「扫码登录」切换到二维码</div>' +
          '<div class="qrstep"><b>③</b> 用手机 Boss App 扫码，并在手机上确认登录</div>' +
          '<p class="tt" style="margin:8px 0 0">扫码确认后本页会自动变为「已连接」，期间请勿关闭该窗口。</p>' +
          '</div>' : '';
      var btnLabel = bossUi.starting ? '打开中…' : (b.state === 'qr' ? '重新打开登录窗口' : '扫码登录');
      var dis = b.state === 'unsupported';
      body = '<div class="boss-row"><span class="' + dotCls + '"></span>' +
        '<span class="tt" style="margin:0">' + esc(bossStateText(b)) + '</span></div>' + qrBox +
        '<div class="seg"><button class="btn sm" id="bossLoginBtn"' + (dis || bossUi.starting ? ' disabled' : '') + '>' +
        btnLabel + '</button></div>' +
        '<p class="tt">登录在弹出的独立浏览器窗口中完成，与你日常浏览器互不干扰；助手不接触密码，登录态只存在本机。</p>';
    }
    return '<div class="card boss-card"><h3>Boss 直聘账号</h3>' + body + '</div>';
  }

  function viewApi() {
    var l = pageState.llm || {};
    var bossCard = viewBossCard();
    var llmCard =
      '<div class="warn-note">密钥与 Cookie 只提交给本机后端加密存储，页面不回显、不留存。</div>' +
      '<div class="card"><h3>LLM 配置（OpenAI 兼容 /chat/completions）</h3>' +
      '<div class="fld"><label>接口地址 endpoint</label><input data-llm="endpoint" value="' + esc(l.endpoint) +
      '" placeholder="https://api.openai.com/v1/chat/completions"></div>' +
      '<div class="row"><div class="fld"><label>API Key</label><input data-llm="apiKey" type="password" value="' + esc(l.apiKey) +
      '" placeholder="sk-…"></div>' +
      '<div class="fld"><label>模型 model</label><input data-llm="model" value="' + esc(l.model) +
      '" placeholder="gpt-4o-mini"></div></div>' +
      '<div class="seg"><button class="btn sm" id="saveLlmBtn">保存</button>' +
      '<button class="btn ghost sm" id="testLlmBtn">测试连接</button></div>' +
      '<div id="llmTest"></div></div>';
    var siteCards = (pageState.sites || []).map(function (s) {
      return '<div class="card"><div class="site">' +
        '<span class="sname">' + esc(s.name) + '</span>' +
        '<span class="badge ' + (s.enabled ? 'b-ok' : 'b-mut') + '">' + (s.enabled ? '启用' : '停用') + '</span>' +
        '<button class="ico-btn" data-edit="' + s.id + '" title="编辑">✎</button>' +
        '<button class="ico-btn" data-toggle="' + s.id + '" title="启用/停用">' + (s.enabled ? '⏸' : '▶') + '</button>' +
        '<button class="ico-btn" data-del="' + s.id + '" title="删除">🗑</button>' +
        '</div>' +
        '<div class="jm" style="margin:7px 0">' + (s.type === 'mock' ? '类型：内置示例数据' : '类型：' + esc(s.type) +
          (s.endpoint ? ' · ' + esc(s.endpoint) : '')) + '</div>' +
        '<div class="tt">抓取间隔 ' + ((s.rateLimit || {}).fetchIntervalMin || 10) +
        ' 分钟｜单次最大投递 ' + ((s.rateLimit || {}).maxBatchSubmit || 5) + '</div>' +
        '<div style="margin-top:8px"><button class="btn ghost sm" data-test="' + s.id + '">测试连接</button></div>' +
        '</div>';
    }).join('');
    var form = siteForm ? siteFormHtml() : '';
    return bossCard + llmCard +
      '<div class="card" style="display:flex;align-items:center"><h3 style="flex:1;margin:0">招聘网站 API / 账号配置</h3>' +
      '<button class="btn sm" id="newSiteBtn">＋添加站点</button></div>' +
      siteCards + form;
  }

  function siteFormHtml() {
    var s = siteForm;
    var isNew = s.id.indexOf('new_') === 0;
    var jsonFields = s.type === 'json' ?
      '<div class="fld"><label>Cookie（登录态，提交后端加密存储）</label>' +
      '<textarea data-sf="cookie" placeholder="粘贴完整 Cookie 字符串">' + esc(s.cookie || '') + '</textarea></div>' +
      '<div class="fld"><label>接口地址（GET，返回 JSON）</label>' +
      '<input data-sf="endpoint" value="' + esc(s.endpoint) + '" placeholder="https://api.example.com/jobs"></div>' +
      '<div class="row"><div class="fld"><label>API Key 参数名</label>' +
      '<input data-sf="apiKeyParam" value="' + esc(s.apiKeyParam) + '" placeholder="key / token"></div>' +
      '<div class="fld"><label>API Key 值</label>' +
      '<input data-sf="apiKey" value="' + esc(s.apiKey) + '" placeholder="可留空"></div></div>' +
      '<div class="card"><h4>风控限速配置</h4><div class="row">' +
      '<div class="fld"><label>抓取间隔(分钟)</label><input data-rate="fetchIntervalMin" value="' +
      esc((s.rateLimit || {}).fetchIntervalMin || 10) + '"></div>' +
      '<div class="fld"><label>单次最大批量投递</label><input data-rate="maxBatchSubmit" value="' +
      esc((s.rateLimit || {}).maxBatchSubmit || 5) + '"></div>' +
      '<div class="fld"><label>投递冷却秒数</label><input data-rate="submitCoolDownSec" value="' +
      esc((s.rateLimit || {}).submitCoolDownSec || 30) + '"></div>' +
      '</div></div>' +
      '<div class="fld"><label>职位列表 JSON 路径</label>' +
      '<input data-sm="jobsPath" value="' + esc(s.mapping && s.mapping.jobsPath || '') + '"></div>' +
      '<div class="row"><div class="fld"><label>岗位字段名</label>' +
      '<input data-sm="titleKey" value="' + esc(s.mapping && s.mapping.titleKey || 'title') + '"></div>' +
      '<div class="fld"><label>公司字段名</label>' +
      '<input data-sm="companyKey" value="' + esc(s.mapping && s.mapping.companyKey || 'company') + '"></div></div>' +
      '<div class="row"><div class="fld"><label>城市字段名</label>' +
      '<input data-sm="cityKey" value="' + esc(s.mapping && s.mapping.cityKey || 'city') + '"></div>' +
      '<div class="fld"><label>薪资字段名</label>' +
      '<input data-sm="salaryKey" value="' + esc(s.mapping && s.mapping.salaryKey || 'salary') + '"></div></div>' +
      '<div class="fld"><label>JD 岗位描述字段名</label>' +
      '<input data-sm="jdKey" value="' + esc(s.mapping && s.mapping.jdKey || 'jd') + '"></div>'
      : '<div class="tt">内置示例数据源，无需配置地址。</div>';
    return '<div class="card"><h3>' + (isNew ? '新增站点' : '编辑站点') + '</h3>' +
      '<div class="row"><div class="fld"><label>名称</label>' +
      '<input data-sf="name" value="' + esc(s.name) + '"></div>' +
      '<div class="fld"><label>类型</label><select data-sf="type">' +
      '<option value="mock"' + (s.type === 'mock' ? ' selected' : '') + '>mock（内置示例）</option>' +
      '<option value="json"' + (s.type === 'json' ? ' selected' : '') + '>json（GET 接口）</option>' +
      '</select></div>' +
      '<div class="fld"><label>启用</label><select data-sf="enabled">' +
      '<option value="1"' + (s.enabled ? ' selected' : '') + '>启用</option>' +
      '<option value="0"' + (!s.enabled ? ' selected' : '') + '>停用</option>' +
      '</select></div></div>' +
      jsonFields +
      '<div class="seg"><button class="btn sm" id="saveSiteBtn">保存</button>' +
      '<button class="btn ghost sm" id="cancelSiteBtn">取消</button></div>' +
      '</div>';
  }

  /* ---------------- 事件绑定 ---------------- */
  function bind() {
    if (tab === 'chat') {
      var msgs = $('msgs');
      if (msgs) msgs.scrollTop = msgs.scrollHeight;
      var inp = $('input');
      if (inp) {
        inp.focus();
        inp.onkeydown = function (e) {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
        };
      }
      var sb = $('sendBtn');
      if (sb) sb.onclick = doSend;
    }
    if (tab === 'config') {
      var b = $('saveCfgBtn');
      if (b) b.onclick = doSaveConfig;
    }
    if (tab === 'resume') {
      var addBtn = $('addResumeBtn');
      if (addBtn) addBtn.onclick = async function () {
        try {
          var vid = 's' + Math.random().toString(36).slice(2, 9);
          await apiPost('/resume/save', {
            vid: vid, name: '新简历', content: '', autoGenMsg: true,
            templateMsg: '您好，看到贵司岗位，希望获得沟通机会。'
          });
          await refreshPageData();
        } catch (e) { setStatus(e.message); render(); }
      };
      var saveBtn = $('saveResumeBtn');
      if (saveBtn) saveBtn.onclick = doSaveResume;
      var cancelBtn = $('cancelResumeBtn');
      if (cancelBtn) cancelBtn.onclick = render;
      document.querySelectorAll('[data-setactive]').forEach(function (n) {
        n.onclick = async function () {
          try {
            await apiPost('/resume/set_active', { vid: n.getAttribute('data-setactive') });
            await refreshPageData();
          } catch (e) { setStatus(e.message); }
        };
      });
      document.querySelectorAll('[data-del-resume]').forEach(function (n) {
        n.onclick = async function () {
          try {
            await apiDelete('/resume/' + n.getAttribute('data-del-resume'));
            await refreshPageData();
          } catch (e) { setStatus(e.message); }
        };
      });
      var addTpl = $('addTplBtn');
      if (addTpl) addTpl.onclick = async function () {
        try {
          var tid = 't' + Math.random().toString(36).slice(2, 9);
          var list = await apiPost('/template/save', {
            tid: tid, name: '',
            content: '您好，看到贵司「{title}」岗位，我的经验与岗位要求较为契合，希望能进一步沟通，谢谢。'
          });
          pageState.templates = list || [];
          setStatus('已新增话术 ' + (list ? list.length : ''));
          await refreshPageData();
        } catch (e) { setStatus(e.message); render(); }
      };
      document.querySelectorAll('[data-tpl-save]').forEach(function (n) {
        n.onclick = async function () {
          var tid = n.getAttribute('data-tpl-save');
          var nameNode = document.querySelector('[data-tpl-name="' + tid + '"]');
          var contentNode = document.querySelector('[data-tpl-content="' + tid + '"]');
          try {
            var list = await apiPost('/template/save', {
              tid: tid, name: nameNode ? nameNode.value.trim() : '',
              content: contentNode ? contentNode.value.trim() : ''
            });
            pageState.templates = list || [];
            setStatus('话术已保存');
            await refreshPageData();
          } catch (e) { setStatus('保存失败：' + e.message); }
        };
      });
      document.querySelectorAll('[data-tpl-del]').forEach(function (n) {
        n.onclick = async function () {
          if (!confirm('删除这条话术？其后的序号会自动前移。')) return;
          try {
            var list = await apiDelete('/template/' + n.getAttribute('data-tpl-del'));
            pageState.templates = list || [];
            await refreshPageData();
          } catch (e) { setStatus(e.message); }
        };
      });
    }
    if (tab === 'match') {
      var bmb = $('bossMatchBtn');
      if (bmb) bmb.onclick = doBossMatch;
      var glb = $('goLoginBtn');
      if (glb) glb.onclick = function () { switchTab('api'); };
      document.querySelectorAll('[data-greet]').forEach(function (n) {
        n.onclick = function () { doGreet(n.getAttribute('data-greet'), n.getAttribute('data-tpl')); };
      });
      if (bossUi.greetCd > 0) setGreetButtons(true);
      document.querySelectorAll('[data-copy]').forEach(function (n) {
        n.onclick = function () { doCopyGreeting(n.getAttribute('data-copy')); };
      });
      document.querySelectorAll('[data-approve]').forEach(function (n) {
        n.onclick = function () { doApprove(n.getAttribute('data-approve'), 'approve'); };
      });
      document.querySelectorAll('[data-reject]').forEach(function (n) {
        n.onclick = function () { doApprove(n.getAttribute('data-reject'), 'reject'); };
      });
      document.querySelectorAll('[data-togglejd]').forEach(function (n) {
        n.onclick = function () {
          var dom = $('jd_' + n.getAttribute('data-togglejd'));
          if (dom) dom.style.display = dom.style.display === 'none' ? 'block' : 'none';
        };
      });
      document.querySelectorAll('[data-editmsg]').forEach(function (n) {
        n.onclick = async function () {
          var jid = n.getAttribute('data-editmsg');
          var qItem = pageState.queue.find(function (x) { return x.jobId === jid; });
          if (!qItem) return;
          var inputMsg = prompt('设置本次岗位自定义自荐话术，留空使用模板', qItem.customMsg || '');
          if (inputMsg !== null) {
            try {
              await apiPost('/job/approve', {
                jobId: jid, action: 'approve', customMsg: inputMsg,
                resumeVid: pageState.resume ? pageState.resume.activeVid : ''
              });
              await refreshPageData();
            } catch (e) { setStatus(e.message); }
          }
        };
      });
    }
    if (tab === 'log') {
      var expBtn = $('exportLogBtn');
      if (expBtn) expBtn.onclick = function () { window.open(API_BASE + '/log/export', '_blank'); };
    }
    if (tab === 'api') {
      var bl = $('bossLoginBtn'); if (bl) bl.onclick = doBossLogin;
      var blo = $('bossLogoutBtn'); if (blo) blo.onclick = doBossLogout;
      var sl = $('saveLlmBtn'); if (sl) sl.onclick = doSaveLlm;
      var tl = $('testLlmBtn'); if (tl) tl.onclick = doTestLlm;
      var ns = $('newSiteBtn');
      if (ns) ns.onclick = function () {
        siteForm = {
          id: 'new_' + Date.now(), name: '', type: 'mock', endpoint: '', cookie: '',
          apiKeyParam: 'key', apiKey: '', enabled: true,
          rateLimit: { fetchIntervalMin: 10, maxBatchSubmit: 5, submitCoolDownSec: 30 },
          mapping: { jobsPath: '', titleKey: 'title', companyKey: 'company', cityKey: 'city', salaryKey: 'salary', jdKey: 'jd' }
        };
        render();
      };
      var ss = $('saveSiteBtn'); if (ss) ss.onclick = doSaveSiteForm;
      var cs = $('cancelSiteBtn');
      if (cs) cs.onclick = function () { siteForm = null; render(); };
      document.querySelectorAll('[data-edit]').forEach(function (n) {
        n.onclick = function () {
          var s = pageState.sites.find(function (x) { return x.id === n.getAttribute('data-edit'); });
          if (s) { siteForm = JSON.parse(JSON.stringify(s)); render(); }
        };
      });
      document.querySelectorAll('[data-toggle]').forEach(function (n) {
        n.onclick = async function () {
          try {
            var sid = n.getAttribute('data-toggle');
            var s = pageState.sites.find(function (x) { return x.id === sid; });
            await apiPost('/site/toggle', { siteId: sid, enabled: !s.enabled });
            await refreshPageData();
          } catch (e) { setStatus(e.message); }
        };
      });
      document.querySelectorAll('[data-del]').forEach(function (n) {
        n.onclick = async function () {
          try {
            await apiDelete('/site/' + n.getAttribute('data-del'));
            await refreshPageData();
          } catch (e) { setStatus(e.message); }
        };
      });
      document.querySelectorAll('[data-test]').forEach(function (n) {
        n.onclick = async function () {
          setBusy(true); setStatus('测试站点…');
          try {
            await apiPost('/site/test', { siteId: n.getAttribute('data-test') });
            setStatus('站点测试完成（示例数据）');
          } catch (e) {
            setStatus('站点测试失败：' + e.message);
          } finally {
            setBusy(false); render();
          }
        };
      });
    }
  }

  async function refreshPageData() { await initLoad(); }

  async function doSend() {
    var inp = $('input');
    var text = (inp.value || '').trim();
    if (!text || busy) return;
    inp.value = '';
    pageState.chat.push({ role: 'user', text: text });
    setBusy(true); render(); setStatus('LLM 分析请求中…');
    try {
      var cfg = await apiGet('/job/config');
      var resp = await apiPost('/llm/analyze_requirement', { current_config: cfg, user_text: text });
      pageState.chat.push({ role: 'assistant', text: resp.reply });
      await apiPost('/job/config', resp.config);
      await refreshPageData();
    } catch (e) {
      pageState.chat.push({ role: 'assistant', text: '请求异常：' + e.message });
      setStatus(e.message);
      render();
    }
    setBusy(false); render();
  }

  async function doSaveConfig() {
    try {
      var payload = {};
      var positions = [];
      document.querySelectorAll('[data-cfg]').forEach(function (node) {
        var k = node.getAttribute('data-cfg');
        if (k === 'targetPositions') {
          var v = node.value.trim();
          if (v && positions.indexOf(v) < 0) positions.push(v);
          return;
        }
        if (k === 'skills' || k === 'blackCompanyList') {
          payload[k] = node.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        } else payload[k] = node.value;
      });
      payload.targetPositions = positions.slice(0, 5);
      payload.targetPosition = positions[0] || '';
      if (!positions.length) { setStatus('至少填一个目标岗位'); return; }
      await apiPost('/job/config', payload);
      setStatus('配置已保存');
      await refreshPageData();
    } catch (e) { setStatus('保存失败：' + e.message); render(); }
  }

  async function doSaveResume() {
    if (!pageState.resume) return;
    try {
      var payload = {
        vid: pageState.resume.activeVid,
        name: $('resume_name').value.trim(),
        content: $('resume_content').value.trim(),
        templateMsg: $('resume_template').value.trim(),
        autoGenMsg: $('resume_autogen').checked
      };
      await apiPost('/resume/save', payload);
      setStatus('简历已保存');
      await refreshPageData();
    } catch (e) { setStatus('保存失败：' + e.message); }
  }

  function switchTab(name) {
    tab = name;
    document.querySelectorAll('#nav button').forEach(function (x) {
      x.classList.toggle('on', x.getAttribute('data-tab') === name);
    });
    render();
  }

  function setGreetButtons(disabled) {
    document.querySelectorAll('[data-greet]').forEach(function (b) {
      b.disabled = !!disabled;
    });
  }

  /* 点岗位卡上的话术序号 → 后端打开 Boss 沟通框、填模板、发送 */
  async function doGreet(jobId, tid) {
    if (bossUi.greetCd > 0) { setStatus('投递冷却中，还剩 ' + bossUi.greetCd + ' 秒'); return; }
    var item = (pageState.queue || []).find(function (x) { return x.jobId === jobId; });
    var tpl = (pageState.templates || []).find(function (t) { return t.tid === tid; });
    if (!item || !tpl) { setStatus('岗位或话术不存在'); return; }
    var j = item.job || {};
    var idx = pageState.templates.indexOf(tpl);
    var who = (j.company ? j.company + ' · ' : '') + (j.hr || 'HR');
    var sure = confirm('将在 Boss 专用浏览器中向「' + who + '」发送话术 ' + CIRCLED[idx] + '「' +
      (tpl.name || '') + '」：\n\n' + (tpl.content || '') + '\n\n确认发送？');
    if (!sure) return;
    setBusy(true); setGreetButtons(true);
    setStatus('正在打开沟通框并发送话术 ' + CIRCLED[idx] + '…');
    try {
      var res = await apiPost('/boss/greet', { jobId: jobId, templateId: tid });
      bossUi.greetCd = res.cooldownLeftSec || 20;
      setStatus('话术 ' + CIRCLED[idx] + ' 已通过 Boss 发出');
      await refreshPageData();
      setGreetButtons(bossUi.greetCd > 0);
    } catch (e) {
      setStatus('发送失败：' + e.message);
      setGreetButtons(false);
      await refreshPageData();  // 后端可能已把该岗位标成投递失败，刷出新徽标
    } finally {
      setBusy(false);
      render();  // 复位顶部「拉取中…」按钮
    }
  }

  /* ---------------- Boss 直聘：扫码登录 / 拉取 / 复制话术 ---------------- */
  function stopBossQrPolling() {
    if (bossUi.timer) { clearInterval(bossUi.timer); bossUi.timer = null; }
  }

  // 原生窗口模式：二维码在用户桌面弹出的专用浏览器窗口里，页面只轮询登录状态。
  function startBossQrPolling() {
    stopBossQrPolling();
    bossUi.timer = setInterval(async function () {
      var st = null;
      try { st = await apiGet('/boss/status'); } catch (e) { return; }
      pageState.boss = st;
      if (st.state === 'qr') return;
      stopBossQrPolling();
      if (st.state === 'logged_in') {
        setStatus('Boss 直聘登录成功');
        await refreshPageData();
      } else if (tab === 'api') {
        render(); // blocked / closed / error：卡片展示原因
      }
    }, 2000);
  }

  async function doBossLogin() {
    if (bossUi.starting) return;
    bossUi.starting = true;
    if (tab === 'api') render();
    setStatus('正在打开 Boss 登录页…');
    try {
      var st = await apiPost('/boss/login/start', {});
      pageState.boss = st;
      if (st.state === 'logged_in') {
        setStatus('Boss 登录态有效，无需重新扫码');
        await refreshPageData();
        return;
      }
      setStatus(st.message || '请扫码登录');
      render();
      if (st.state === 'qr') startBossQrPolling();
    } catch (e) {
      setStatus('Boss 登录启动失败：' + e.message);
    } finally {
      bossUi.starting = false;
      if (tab === 'api') render(); // 复位「打开中…」按钮（二维码轮询不受影响）
    }
  }

  async function doBossLogout() {
    stopBossQrPolling();
    try {
      pageState.boss = await apiPost('/boss/logout', {});
      bossUi.cooldown = 0;
      setStatus('已退出 Boss 登录');
    } catch (e) { setStatus('退出失败：' + e.message); }
    render();
  }

  async function doBossMatch() {
    if (busy || bossUi.cooldown > 0) return;
    setBusy(true); setStatus('正在从 Boss 直聘拉取岗位（只读，约需十几秒）…'); render();
    try {
      var res = await apiPost('/boss/match', {});
      try {
        var st = await apiGet('/boss/status');
        pageState.boss = st;
        bossUi.cooldown = st.cooldownLeftSec || 1;
      } catch (e) { bossUi.cooldown = 1; }
      setStatus('已从 Boss 拉取 ' + (res.totalJobs || 0) + ' 个新岗位，请逐条批复');
      await refreshPageData();
    } catch (e) {
      try {
        pageState.boss = await apiGet('/boss/status');
        bossUi.cooldown = pageState.boss.cooldownLeftSec || 0;
      } catch (e2) {}
      setStatus('Boss 拉取失败：' + e.message);
    } finally {
      setBusy(false); render();
    }
  }

  function copyTextFallback(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }

  async function doCopyGreeting(jobId) {
    var item = pageState.queue.find(function (x) { return x.jobId === jobId; });
    if (!item || !item.customMsg) { setStatus('该岗位没有现成话术'); return; }
    var ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(item.customMsg);
        ok = true;
      }
    } catch (e) { ok = false; }
    if (!ok) ok = copyTextFallback(item.customMsg);
    setStatus(ok ? '招呼话术已复制，请到 Boss 页面粘贴并由你本人发送' : '复制失败，请手动选取话术文字');
  }

  async function doApprove(jobId, action) {
    try {
      await apiPost('/job/approve', {
        jobId: jobId, action: action, customMsg: '',
        resumeVid: pageState.resume ? pageState.resume.activeVid : ''
      });
      var qi = pageState.queue.find(function (x) { return x.jobId === jobId; });
      var bossSrc = qi && qi.job && qi.job.source === 'Boss直聘';
      setStatus(action === 'approve'
        ? (bossSrc ? '已标记待回复' : '已批准入投递队列')
        : (bossSrc ? '已跳过' : '已驳回'));
      await refreshPageData();
    } catch (e) { setStatus('批复失败：' + e.message); }
  }

  async function doSaveLlm() {
    try {
      var payload = {};
      document.querySelectorAll('[data-llm]').forEach(function (node) {
        payload[node.getAttribute('data-llm')] = node.value;
      });
      await apiPost('/llm/config', payload);
      setStatus('LLM 配置已保存');
      await refreshPageData();
    } catch (e) { setStatus('保存失败：' + e.message); }
  }

  async function doTestLlm() {
    var out = $('llmTest');
    out.innerHTML = '<div class="tt"><span class="spin"></span> 测试中</div>';
    try {
      var res = await apiPost('/llm/test', {});
      out.innerHTML = '<div class="tt" style="color:var(--songlv-soft)">✓ ' + esc(res.echo) + '</div>';
    } catch (e) {
      out.innerHTML = '<div class="tt" style="color:#7E3B2C">✗ ' + esc(e.message) + '</div>';
    }
  }

  async function doSaveSiteForm() {
    if (!siteForm) return;
    document.querySelectorAll('[data-sf]').forEach(function (node) {
      var k = node.getAttribute('data-sf');
      var v = node.value;
      if (k === 'enabled') v = (v === '1');
      siteForm[k] = v;
    });
    document.querySelectorAll('[data-rate]').forEach(function (node) {
      siteForm.rateLimit[node.getAttribute('data-rate')] = Number(node.value) || 0;
    });
    document.querySelectorAll('[data-sm]').forEach(function (node) {
      siteForm.mapping[node.getAttribute('data-sm')] = node.value;
    });
    try {
      await apiPost('/site/save', siteForm);
      siteForm = null;
      setStatus('站点保存成功');
      await refreshPageData();
    } catch (e) { setStatus('保存失败：' + e.message); render(); }
  }

  /* ---------------- Tab 导航 ---------------- */
  $('nav').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-tab]');
    if (b) switchTab(b.getAttribute('data-tab'));
  });

  // Boss 冷却倒计时：只改按钮状态，不整页重绘。
  setInterval(function () {
    if (bossUi.cooldown > 0) {
      bossUi.cooldown--;
      if (tab === 'match') {
        var btn = $('bossMatchBtn');
        if (btn) {
          if (bossUi.cooldown > 0) {
            btn.textContent = '拉取冷却中 ' + bossUi.cooldown + ' 秒';
            btn.disabled = true;
          } else {
            btn.textContent = '从 Boss 直聘拉取岗位';
            btn.disabled = false;
          }
        }
      }
    }
    if (bossUi.greetCd > 0) {
      bossUi.greetCd--;
      if (bossUi.greetCd === 0 && tab === 'match') setGreetButtons(false);
    }
  }, 1000);

  /* ---------------- 口令门 ---------------- */
  async function sha256Hex(text) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(function (b) {
      return b.toString(16).padStart(2, '0');
    }).join('');
  }

  function enterApp() {
    $('gate').hidden = true;
    $('app').hidden = false;
    initLoad();
  }

  async function tryPass(pass) {
    var digest = await sha256Hex(pass);
    if (digest !== PASS_SHA256) return false;
    try { sessionStorage.setItem(UNLOCK_KEY, '1'); } catch (e) { /* 隐私模式等：本次仍放行 */ }
    return true;
  }

  var gateForm = $('gate-form');
  var gateInput = $('gate-input');
  var gateErr = $('gate-err');

  gateForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var pass = gateInput.value || '';
    if (!pass) return;
    if (await tryPass(pass)) {
      enterApp();
    } else {
      gateErr.hidden = false;
      gateInput.value = '';
      gateInput.focus();
    }
  });

  var unlocked = false;
  try { unlocked = sessionStorage.getItem(UNLOCK_KEY) === '1'; } catch (e) {}
  if (unlocked) enterApp();
})();
