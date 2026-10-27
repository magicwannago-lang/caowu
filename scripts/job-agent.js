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
  var pageState = {
    llm: null,
    config: null,
    resume: null,
    sites: [],
    queue: [],
    submitLog: [],
    chat: [{
      role: 'assistant',
      text: '你好！我是招聘投递助手。\n1) 输入求职要求，后端 LLM 解析更新配置；\n2) 维护简历版本，配置招聘站点账号；\n3) 拉取岗位，人工批复后进入投递队列；\n4) 投递结果查看投递日志。'
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
    function fld(k, label, ph) {
      return '<div class="fld"><label>' + label + '</label>' +
        '<input data-cfg="' + k + '" value="' + esc(c[k] != null ? c[k] : '') + '" placeholder="' + ph + '"></div>';
    }
    return '<div class="card"><h3>基础配置（应聘要求）</h3>' +
      fld('targetPosition', '目标岗位', '如 后端开发工程师') +
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
    return '<div class="warn-note">简历、自荐话术用于 Agent 投递；批准岗位投递时还可以单条覆盖本次自荐消息。</div>' +
      '<div class="card"><h3>简历版本管理</h3><button class="btn sm" id="addResumeBtn">＋新增简历版本</button></div>' +
      listHtml + editFormHtml;
  }

  function viewMatch() {
    var q = pageState.queue || [];
    if (q.length === 0) {
      return '<div class="card"><button class="btn" id="matchBtn">' + (busy ? '匹配中…' : '开始匹配') + '</button></div>' +
        '<div class="hint">点「开始匹配」，后端拉取岗位并打分，人工批复后进入投递队列。</div>';
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
      '<button class="btn" id="matchBtn">' + (busy ? '匹配中…' : '重新匹配') + '</button>' +
      '<span class="tt" style="margin:0">共 ' + stats.total + '｜待批复 ' + stats.pending +
      '｜待投递队列 ' + stats.queue + '｜投递成功 ' + stats.success + '｜已驳回 ' + stats.reject + '</span>' +
      '</div>' + heads + cols;
  }

  function jobCard(it) {
    var j = it.job || {};
    var st = it.status || 'pending';
    var badgeTxt = '';
    if (st === 'pending') badgeTxt = '<span class="badge b-warn">待批复</span>';
    else if (st === 'queue') badgeTxt = '<span class="badge b-warn">已批准，待投递</span>';
    else if (st === 'success') badgeTxt = '<span class="badge b-ok">投递成功</span>';
    else if (st === 'fail') badgeTxt = '<span class="badge b-bad">投递失败</span>';
    else if (st === 'rejected') badgeTxt = '<span class="badge b-bad">已驳回</span>';

    var actsHtml = '';
    if (st === 'pending') {
      actsHtml =
        '<button class="btn ok sm" data-approve="' + it.jobId + '">批准入投递队列</button>' +
        '<button class="btn bad sm" data-reject="' + it.jobId + '">驳回</button>' +
        '<button class="btn ghost sm" data-editmsg="' + it.jobId + '">编辑本次自荐语</button>';
    }
    var jdHtml = j.jd ? '<div style="margin:6px 0"><button class="btn ghost sm" data-togglejd="' + it.jobId +
      '">展开 / 收起 JD</button><div id="jd_' + it.jobId + '" class="expand-block" style="display:none">' +
      esc(j.jd) + '</div></div>' : '';
    var customMsgHtml = it.customMsg ? '<div class="tt">本次自定义自荐：' + esc(it.customMsg) + '</div>' : '';

    return '<div class="job ' + st + '">' +
      '<div class="jt">' + esc(j.title || '') + ' · ' + esc(j.company || '') + '</div>' +
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

  function viewApi() {
    var l = pageState.llm || {};
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
    return llmCard +
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
    }
    if (tab === 'match') {
      var mb = $('matchBtn');
      if (mb) mb.onclick = doMatch;
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
      document.querySelectorAll('[data-cfg]').forEach(function (node) {
        var k = node.getAttribute('data-cfg');
        if (k === 'skills' || k === 'blackCompanyList') {
          payload[k] = node.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        } else payload[k] = node.value;
      });
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

  async function doMatch() {
    setBusy(true); setStatus('开始匹配岗位…'); render();
    try {
      await apiPost('/job/match', {});
      await refreshPageData();
    } catch (e) {
      setStatus('匹配失败：' + e.message);
    } finally {
      setBusy(false); render();
    }
  }

  async function doApprove(jobId, action) {
    try {
      await apiPost('/job/approve', {
        jobId: jobId, action: action, customMsg: '',
        resumeVid: pageState.resume ? pageState.resume.activeVid : ''
      });
      setStatus(action === 'approve' ? '已批准入投递队列' : '已驳回');
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
    if (b) {
      tab = b.getAttribute('data-tab');
      document.querySelectorAll('#nav button').forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      render();
    }
  });

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
