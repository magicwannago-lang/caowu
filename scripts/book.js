/* ============================================================
   草屋 · 大儒呈作（衡几第三件器物）
   接线：文稿上传（点击/拖入，就地读取）、蓝图确认、分节起草、
   三校进度、定稿预览、书卷下载。支持 .txt / .md / .docx / .doc；
   Word 解析库（mammoth、word-extractor）首次用到才加载。
   API 在 hengji.js；蓝图/定稿失败有本地兜底。
   不存任何东西、关掉页面即散。
   ============================================================ */

(function () {
  'use strict';

  var hengji = window.Hengji;
  if (!hengji) return;

  var spiritEl = document.getElementById('book-spirit');
  var wordsEl = document.getElementById('book-words');
  var dropEl = document.getElementById('book-drop');
  var fileEl = document.getElementById('book-file');
  var fileNote = document.getElementById('book-file-note');
  var runBtn = document.getElementById('book-run');
  var confirmBtn = document.getElementById('book-confirm');
  var stagesEl = document.getElementById('book-stages');
  var reviewsEl = document.getElementById('book-reviews');
  var outputEl = document.getElementById('book-output');
  var downloadBtn = document.getElementById('book-download');
  var hintEl = document.getElementById('book-hint');
  var suggestBtn = document.getElementById('book-suggest');

  if (!spiritEl || !runBtn) return;

  var manuscript = '';

  // uiMode：idle | blueprinting | awaiting | working | stopped | done
  var uiMode = 'idle';
  var state = null;

  /* ---------- 1. Word 解析库：首次上传前懒加载 ---------- */

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('解析库没加载进来')); };
      document.head.appendChild(s);
    });
  }

  // .docx：mammoth 一家即可
  var docxPromise = null;
  function loadDocxParser() {
    if (!docxPromise) docxPromise = loadScript('assets/vendor/mammoth.browser.min.js');
    return docxPromise;
  }

  // .doc：先 Buffer polyfill，再 process runtime，最后 word-extractor（顺序不可换）
  var docPromise = null;
  function loadDocParser() {
    if (!docPromise) {
      docPromise = loadScript('assets/vendor/buffer.browser.js')
        .then(function () { return loadScript('assets/vendor/word-runtime.js'); })
        .then(function () { return loadScript('assets/vendor/word-extractor.browser.js'); });
    }
    return docPromise;
  }

  /* ---------- 2. 文稿上传 ---------- */

  function readWord(file, ext) {
    var parserReady = ext === 'docx' ? loadDocxParser() : loadDocParser();

    return parserReady.then(function () {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () {
          var ab = r.result;

          if (ext === 'docx') {
            if (!window.mammoth) return reject(new Error('docx 解析库不可用'));
            window.mammoth.extractRawText({ arrayBuffer: ab })
              .then(function (res) { resolve(res.value || ''); })
              .catch(reject);
          } else {
            // 旧版 .doc：word-extractor + 预先注入的 Buffer/process
            if (!window.WordExtractor || !window.Buffer || !window.process) {
              return reject(new Error('doc 解析库不可用'));
            }
            var extractor = new window.WordExtractor();
            extractor.extract(window.Buffer.from(ab))
              .then(function (doc) { resolve(doc.getBody() || ''); })
              .catch(reject);
          }
        };
        r.onerror = function () { reject(new Error('文稿读不出来')); };
        r.readAsArrayBuffer(file);
      });
    });
  }

  function loadFile(file) {
    if (!file) return;

    var m = /\.([^.]+)$/.exec(file.name);
    var ext = m ? m[1].toLowerCase() : '';

    fileNote.textContent = '正在翻检「' + file.name + '」…';
    dropEl.classList.remove('has-file');

    var done = function (text) {
      manuscript = String(text || '');
      var chars = manuscript.replace(/\s/g, '').length;
      fileNote.textContent = file.name + ' · 约 ' + chars + ' 字（点此更换）';
      dropEl.classList.add('has-file');
    };

    if (ext === 'txt' || ext === 'md') {
      var reader = new FileReader();
      reader.onload = function () { done(reader.result); };
      reader.onerror = function () { fileNote.textContent = '文稿读不出来，换一份试试'; };
      reader.readAsText(file);
    } else if (ext === 'docx' || ext === 'doc') {
      readWord(file, ext).then(done).catch(function (err) {
        fileNote.textContent = err && err.message
          ? err.message
          : 'Word 文稿读不出来；.doc 旧文件可先另存为 .docx 再传';
      });
    } else {
      fileNote.textContent = '只收 .txt / .md / Word 文件，换一份试试';
    }
  }

  // 点击/键盘唤起文件选择
  dropEl.addEventListener('click', function () { fileEl.click(); });
  dropEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileEl.click();
    }
  });
  fileEl.addEventListener('change', function () {
    loadFile(fileEl.files && fileEl.files[0]);
  });

  // 拖入
  ['dragenter', 'dragover'].forEach(function (ev) {
    dropEl.addEventListener(ev, function (e) {
      e.preventDefault();
      dropEl.classList.add('is-over');
    });
  });
  ['dragleave', 'dragend', 'drop'].forEach(function (ev) {
    dropEl.addEventListener(ev, function (e) {
      e.preventDefault();
      dropEl.classList.remove('is-over');
    });
  });
  dropEl.addEventListener('drop', function (e) {
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  /* ---------- 3. 阶段与批注渲染 ---------- */

  function stageLi(stage) {
    return stagesEl.querySelector('li[data-stage="' + stage + '"]');
  }

  function clearStages() {
    stagesEl.removeAttribute('hidden');
    stagesEl.querySelectorAll('li').forEach(function (li) {
      li.classList.remove('is-active', 'is-done');
    });
    reviewsEl.textContent = '';
  }

  // cls：'active' | 'done' | ''（清态）
  function markStage(stage, cls) {
    var li = stageLi(stage);
    if (!li) return;
    li.classList.remove('is-active', 'is-done');
    if (cls === 'active' || cls === 'done') {
      li.classList.add(cls === 'active' ? 'is-active' : 'is-done');
    }
  }

  function setMeta(which, str) {
    var el = document.getElementById('book-' + which + '-meta');
    if (!el) return;
    el.textContent = str || '';
    // 未竟/未足：以实色赭石点醒，不靠透明度
    el.classList.toggle('is-warn', /未竟|未足/.test(str));
  }

  function renderReviews(reviews) {
    reviewsEl.textContent = '';
    reviews.forEach(function (rv) {
      var li = document.createElement('li');
      li.setAttribute('data-review', rv.key);
      var name = document.createElement('span');
      name.className = 'book-review-name';
      name.textContent = rv.name || rv.key;
      var body = document.createElement('span');
      body.className = 'book-review-text';
      body.textContent = rv.missing ? '（失约，无意见）' : rv.text;
      li.appendChild(name);
      li.appendChild(body);
      reviewsEl.appendChild(li);
    });
  }

  /* ---------- 4. 蓝图：配额归一 ---------- */

  function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // 定稿天然收束约一成（修订删并重复，实测定稿/起草 ≈ 0.88–0.95）：
  // 起草配额预留余量，定稿验收按 share（目标份额），成书才守得住目标。
  var DRAFT_SLOP = 1.12;

  function planSections(bp, T) {
    var sections = [];
    var preQ = clampNum(Math.round(T * 0.08), 300, 900);
    sections.push({
      id: 's0', kind: 'front', title: bp.prefaceTitle,
      share: preQ, quota: Math.round(preQ * DRAFT_SLOP),
      points: [], fragments: [], note: bp.prefaceNote
    });

    var epiQ = bp.epilogueNote ? clampNum(Math.round(T * 0.06), 200, 700) : 0;
    var bodyPool = T - preQ - epiQ;

    var weights = bp.chapters.map(function (c) { return clampNum(c.words, 500, 6000); });
    var wSum = weights.reduce(function (a, b) { return a + b; }, 0);
    var n = weights.length;

    // 按权重摊正文池；500 底线只在 n×500 放得下时启用——
    // 小目标配多章时（如 4000 字 6 章）不可硬抬底线，否则会算出负配额。
    var floor = n * 500 <= bodyPool ? 500 : 0;
    var raw = weights.map(function (w) { return bodyPool * w / wSum; });
    var quotas = raw.map(function (r) { return Math.max(floor, Math.floor(r)); });

    // 最大余量法把余数逐字补给小数部分最大的章，使 Σ配额 = 正文池
    var diff = bodyPool - quotas.reduce(function (a, b) { return a + b; }, 0);
    var order = raw.map(function (r, i) {
      return { i: i, frac: r - Math.floor(r) };
    }).sort(function (a, b) { return b.frac - a.frac; });
    for (var k = 0; k < diff; k++) {
      quotas[order[k % n].i]++;
    }

    bp.chapters.forEach(function (c, i) {
      sections.push({
        id: 's' + (i + 1), kind: 'body', title: c.title,
        share: quotas[i], quota: Math.round(quotas[i] * DRAFT_SLOP),
        points: c.points, fragments: c.fragments, note: ''
      });
    });

    if (epiQ) {
      sections.push({
        id: 'sz', kind: 'back', title: '后记',
        share: epiQ, quota: Math.round(epiQ * DRAFT_SLOP),
        points: [], fragments: [], note: bp.epilogueNote
      });
    }
    return sections;
  }

  function renderBlueprint(banner) {
    var bp = state.blueprint;
    var L = [];
    if (banner) L.push(banner, '');
    L.push('《' + bp.title + '》', '');

    state.sections.forEach(function (s) {
      L.push('■ ' + s.title + '（约 ' + s.share + ' 字）');
      if (s.note) L.push('　' + s.note);
      s.points.forEach(function (p, i) { L.push('　' + (i + 1) + ') ' + p); });
      if (s.fragments.length) L.push('　含原稿原句 ' + s.fragments.length + ' 段');
    });

    L.push('', '合计目标：' + state.target + ' 字（非空白计）；起草时多写一成二余量，供定稿收束');
    show(L.join('\n'));
  }

  /* 蓝图兜底：大儒未应答时，从原稿标题抽章，抽不到用通用三章 */
  function fallbackBlueprint() {
    var titles = [];
    manuscript.split('\n').forEach(function (line) {
      var m = line.match(/^\s*#{2,3}\s+(.+?)\s*#*\s*$/);
      if (m && titles.indexOf(m[1]) < 0) titles.push(m[1]);
    });
    titles = titles.slice(0, 4);
    if (titles.length < 2) {
      titles = ['立意：沉静中之所向', '展开：万物关系之辨', '收束：知行之归'];
    }

    var tm = manuscript.match(/^\s*#\s+(.{1,20})/m);
    var title = tm ? tm[1].trim() : '草屋杂思';

    var bp = {
      title: title,
      prefaceTitle: '自序',
      prefaceNote: '交代著书缘起与本心',
      epilogueNote: '记成书之感与来日',
      manuscriptDigest: '',
      chapters: titles.map(function (t) {
        return { title: t, words: 3000, points: ['义理层层展开', '例证、典故与收束'], fragments: [] };
      })
    };
    return bp;
  }

  /* ---------- 5. 成书拼装 ---------- */

  // 剥掉模型自带的同名标题行；标题由拼装口统一加
  var HEADING_PUNCT = /[\s，,。.:：·…—\-（）()【】《》「」『』“”'']/g;
  function headingNorm(s) { return s.replace(HEADING_PUNCT, ''); }

  // 去标题行、去空白计字（与服务端口径一致）
  function plainChars(s) {
    return String(s || '').split('\n')
      .filter(function (l) { return !/^\s*#{1,6}\s/.test(l); })
      .join('').replace(/\s/g, '').length;
  }

  // 模型自加的标题行与本节名目是否同指：允许「第六章 X」式变体
  function headingSame(text, title) {
    var h = headingNorm(text), t = headingNorm(title);
    return Boolean(h && t && (h === t || h.indexOf(t) >= 0 || (t.indexOf(h) >= 0 && h.length >= 4)));
  }

  // 剥掉越权自添的「## 目录」页（随后一串编号清单）
  function stripTocFront(s) {
    var lines = String(s).split('\n'), out = [];
    for (var i = 0; i < lines.length; i++) {
      if (/^\s*#{1,6}\s*目录\s*#*\s*$/.test(lines[i])) {
        i++;
        while (i < lines.length &&
          /^\s*(?:\d+\s*[.、]\s*\S.*|[·•・]\s*\S.*|[—-]{2,}.*|\s*)$/.test(lines[i])) i++;
        i--;
        continue;
      }
      out.push(lines[i]);
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  // ASCII . ! ? 一并算句读：模型偶以英文标点收尾，不该误判悬尾
  var TAIL_PUNCT = /[。！？…」』）”.!?]/;

  // 末字落在句读（或闭合引号／括号）才算收束干净
  function endsCleanText(s) {
    return TAIL_PUNCT.test(String(s || '').replace(/\s+$/, '').slice(-1));
  }

  // 卸下末尾悬在半空的残句，截到最后一个句读；正文本身干净则原样返回。
  function trimDangling(s) {
    s = String(s || '').replace(/\s+$/, '');
    if (!s || endsCleanText(s)) return s;
    var m = s.match(/[\s\S]*[。！？…」』）”.!?]/);
    return m ? m[0].replace(/\s+$/, '') : s;
  }

  function canonicalBody(raw, title) {
    var t = String(raw || '').replace(/^\s+/, '');
    // 模型自加标题行可不止一行（如「### 第六章 X」），逐行剥
    for (;;) {
      var nl = t.indexOf('\n');
      var first = nl >= 0 ? t.slice(0, nl) : t;
      var m = first.match(/^\s*#{1,6}\s+(.*?)\s*#*\s*$/);
      if (m && headingSame(m[1], title)) {
        t = nl >= 0 ? t.slice(nl + 1).replace(/^\s+/, '') : '';
      } else break;
    }
    return stripTocFront(t).replace(/^\s+/, '');
  }

  // bodies：id → 正文 的映射
  function assembleBook(bodies) {
    var bp = state.blueprint;
    var front = null, back = null;
    var bodySecs = [];
    state.sections.forEach(function (s) {
      if (s.kind === 'front') front = s;
      else if (s.kind === 'back') back = s;
      else bodySecs.push(s);
    });

    var out = ['# ' + bp.title, ''];
    if (front) {
      out.push('## ' + front.title, '',
        canonicalBody(bodies[front.id] || '', front.title).trim(), '');
    }

    out.push('## 目录', '');
    bodySecs.forEach(function (s, i) { out.push((i + 1) + '. ' + s.title); });
    out.push('');

    bodySecs.forEach(function (s) {
      out.push('### ' + s.title, '',
        canonicalBody(bodies[s.id] || '', s.title).trim(), '');
    });

    if (back) {
      out.push('## ' + back.title, '',
        canonicalBody(bodies[back.id] || '', back.title).trim(), '');
    }

    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  // 起草时边收边拼：已定各节用 drafts，当前节用流文本
  function renderLive(currentId, raw) {
    var bodies = {};
    Object.keys(state.drafts).forEach(function (id) { bodies[id] = state.drafts[id]; });
    bodies[currentId] = raw;
    show(assembleBook(bodies));
    outputEl.scrollTop = outputEl.scrollHeight;
  }

  function lightBlueprint() {
    var bp = state.blueprint;
    return {
      title: bp.title,
      manuscriptDigest: bp.manuscriptDigest,
      chapters: state.sections.filter(function (s) { return s.kind === 'body'; })
        .map(function (s) { return { title: s.title }; })
    };
  }

  /* ---------- 6. 总流程 ---------- */

  function show(text) {
    outputEl.textContent = text;
    outputEl.removeAttribute('hidden');
  }

  function setBtn(disabled, text) {
    runBtn.disabled = disabled;
    runBtn.textContent = text;
  }

  function setHint(text) { if (hintEl) hintEl.textContent = text; }

  function readTarget() {
    var T = parseInt(wordsEl.value, 10);
    if (!(T >= 4000 && T <= 30000)) {
      T = 10000;
      wordsEl.value = 10000;
    }
    return T;
  }

  // runBtn：擘画 / 重新擘画 / 续上未竟之章 / 再呈一部
  runBtn.addEventListener('click', function () {
    var spirit = spiritEl.value.trim();

    if (uiMode === 'working' || uiMode === 'blueprinting') return;

    if (uiMode === 'stopped') {
      if (!spirit) { spiritEl.focus(); return; }
      resumeDrafting();
      return;
    }

    // idle / done / awaiting → （重新）擘画
    if (!spirit) {
      show('先写下作者的精神状态与写书内核。几句话就够——写不出，书还没有根。');
      spiritEl.focus();
      return;
    }
    startBlueprint();
  });

  function startBlueprint() {
    var T = readTarget();
    state = { target: T, blueprint: null, sections: [], drafts: {}, finals: {}, reviews: null, cursor: 0, shortfalls: [] };
    uiMode = 'blueprinting';
    wordsEl.disabled = false; // 上一轮确认后曾禁用；重新擘画时交还字数设定

    downloadBtn.setAttribute('hidden', '');
    confirmBtn.setAttribute('hidden', '');
    clearStages();
    markStage('blueprint', 'active');
    setMeta('blueprint', '');
    setMeta('draft', '');
    setMeta('final', '');
    setBtn(true, '大儒正在擘画…');
    setHint('大儒正在擘画蓝图…');
    show('');

    var spirit = spiritEl.value.trim();
    hengji.bookBlueprint(spirit, manuscript, T).then(function (bp) {
      enterAwaiting(bp, null);
    }).catch(function () {
      enterAwaiting(fallbackBlueprint(), '蓝图兜底（大儒未应答，此为本地所拟，仍可确认）');
    });
  }

  function enterAwaiting(bp, banner) {
    state.blueprint = bp;
    state.sections = planSections(bp, state.target);
    renderBlueprint(banner);
    markStage('blueprint', 'done');
    confirmBtn.removeAttribute('hidden');
    uiMode = 'awaiting';
    setBtn(false, '重新擘画');
    setHint('蓝图已呈；确认后动笔，不合意可重新擘画');
    offerSuggestedWords(bp);
  }

  // 大儒建议字数：蓝图各章自报篇幅占全书约 86%（自序 8%＋后记 6%），
  // 反推全书篇幅，按百位取整、夹在合法区间。与当前目标相差逾半成方推荐。
  function recommendedWords(bp) {
    var wSum = bp.chapters
      .map(function (c) { return clampNum(c.words, 500, 6000); })
      .reduce(function (a, b) { return a + b; }, 0);
    if (!wSum) return null;
    var T = Math.round(wSum / 0.86 / 100) * 100;
    return Math.max(4000, Math.min(30000, T));
  }

  function offerSuggestedWords(bp) {
    if (!suggestBtn) return;
    var rec = recommendedWords(bp);
    if (rec && Math.abs(rec - state.target) > state.target * 0.05) {
      suggestBtn.textContent = '采用建议字数 · ' + rec + ' 字';
      suggestBtn.recommended = rec;
      suggestBtn.removeAttribute('hidden');
    } else {
      suggestBtn.setAttribute('hidden', '');
    }
  }

  // 采用建议（或确认前手动改字数）：重算各节份额并重绘蓝图
  suggestBtn && suggestBtn.addEventListener('click', function () {
    if (uiMode !== 'awaiting' || !suggestBtn.recommended) return;
    applyTarget(suggestBtn.recommended);
  });

  wordsEl.addEventListener('change', function () {
    if (uiMode !== 'awaiting') return;
    var T = readTarget();
    if (T !== state.target) applyTarget(T);
  });

  function applyTarget(T) {
    state.target = T;
    state.sections = planSections(state.blueprint, T);
    renderBlueprint(null);
    suggestBtn.setAttribute('hidden', '');
  }

  confirmBtn.addEventListener('click', function () {
    if (uiMode !== 'awaiting') return;
    confirmBtn.setAttribute('hidden', '');
    wordsEl.disabled = true;
    uiMode = 'working';
    setBtn(true, '呈作中…');
    setHint('大儒正在著书；定稿成卷后方可下载');
    loopDraft();
  });

  /* ---- 起草：逐节，单节失败重试一次（带 seed），再败硬停 ---- */

  function resumeDrafting() {
    uiMode = 'working';
    setBtn(true, '呈作中…');
    setHint('大儒正在著书；定稿成卷后方可下载');
    markStage('draft', 'active');
    loopDraft();
  }

  function loopDraft() {
    markStage('draft', 'active');

    // 函数声明：callDraft 的回调在异步 then 里也要调 next，故须在 loopDraft
    // 作用域内可见——不能写成命名函数表达式（其名仅 IIFE 内部可见）。
    function next() {
      if (state.cursor >= state.sections.length) {
        markStage('draft', 'done');
        runReview();
        return;
      }

      var i = state.cursor;
      var sec = state.sections[i];
      var prev = state.sections.slice(0, i).map(function (s) {
        return { id: s.id, kind: s.kind, title: s.title, body: state.drafts[s.id] || '' };
      });

      setMeta('draft', '第 ' + (i + 1) + ' / ' + state.sections.length + ' 节 · ' + sec.title);
      callDraft(sec, prev, '', 0);
    }
    next();

    function callDraft(sec, prev, seed, attempt) {
      var live = '';

      hengji.bookDraftSection({
        spirit: spiritEl.value.trim(),
        targetWords: state.target,
        section: sec,
        blueprint: lightBlueprint(),
        prevSections: prev,
        seed: seed
      }, {
        onChunk: function (full) {
          live = full;
          renderLive(sec.id, full);
        }
      }).then(function (r) {
        settle(canonicalBody(r.text, sec.title));
      }).catch(function () {
        if (attempt < 2) {
          var liveSeed = live.replace(/\s/g, '').length >= 200
            ? canonicalBody(live, sec.title)
            : '';
          callDraft(sec, prev, liveSeed, attempt + 1);
        } else {
          hardStop();
        }
      });

      // 验收：不足八成五配额或末句不收即为未成，带 server 定稿 seed 再来；
      // 三次仍不成则截去残句、记下名目，继续写后面的节，不为一节拖死全书。
      function settle(body) {
        var chars = plainChars(body);
        var clean = endsCleanText(body);

        // 验收按目标份额 share（quota 是含余量的起草上限，不用于判短收）
        if ((!clean || chars < sec.share * 0.85) && attempt < 2) {
          callDraft(sec, prev, chars >= 200 ? body : '', attempt + 1);
          return;
        }
        if (!clean) body = trimDangling(body);
        if (plainChars(body) < sec.share * 0.85) state.shortfalls.push(sec.title);
        state.drafts[sec.id] = body;
        state.cursor++;
        next();
      }
    }
  }

  function hardStop() {
    uiMode = 'stopped';
    setMeta('draft', '未竟 · 已成 ' + state.cursor + ' / ' + state.sections.length + ' 节');
    setHint('管线中断于此；点「续上未竟之章」接着写');
    show(assembleBook(state.drafts).trim() + '\n\n（呈作中断于此，点「续上未竟之章」接着写）');
    outputEl.scrollTop = outputEl.scrollHeight;
    setBtn(false, '续上未竟之章');
  }

  /* ---- 三校 ---- */

  function runReview() {
    markStage('review', 'active');
    var sections = state.sections.map(function (s) {
      return { id: s.id, kind: s.kind, title: s.title, body: state.drafts[s.id] || '' };
    });

    hengji.bookReview(spiritEl.value.trim(), state.target, sections)
      .then(function (reviews) {
        state.reviews = reviews;
        renderReviews(reviews);
        markStage('review', 'done');
        runFinal();
      }).catch(function () {
        state.reviews = [];
        markStage('review', 'done');
        runFinal();
      });
  }

  /* ---- 定稿：默认全书一次（≤12000）；超限逐节 ---- */

  function runFinal() {
    markStage('final', 'active');
    setBtn(true, '定稿中…');
    setHint('大儒正在定稿；定稿成卷后方可下载');

    if (state.target > 12000) finalizeByChapter();
    else finalizeByBook();
  }

  function draftSections() {
    return state.sections.map(function (s) {
      return { id: s.id, kind: s.kind, title: s.title, body: state.drafts[s.id] || '' };
    });
  }

  function finalizeByBook() {
    var bookDraft = { title: state.blueprint.title, sections: draftSections() };
    var live = '';

    callBook(bookDraft, '', 0);

    function callBook(bd, seed, attempt) {
      hengji.bookFinalSection({
        spirit: spiritEl.value.trim(),
        targetWords: state.target,
        scope: 'book',
        blueprint: lightBlueprint(),
        bookDraft: bd,
        reviews: state.reviews,
        seed: seed
      }, {
        onChunk: function (full) {
          live = full;
          show(full);
          outputEl.scrollTop = outputEl.scrollHeight;
        }
      }).then(function (r) {
        // 定稿以目标字数为准（初稿或因配额放行略有出入），另防真正的短吐与残尾：
        // 不达标或不收尾则带 seed 重试一次，再不成宁可沿用初稿。
        var finalText = r.text || '';
        var draftText = assembleBook(state.drafts);
        var good = plainChars(finalText) >= state.target * 0.95 &&
          plainChars(finalText) >= plainChars(draftText) * 0.8 &&
          endsCleanText(finalText);
        if (!good && attempt < 1) {
          callBook(bd, finalText, attempt + 1);
        } else if (good) {
          finishWith(finalText, false);
        } else {
          finishWith(draftText + '（定稿未竟，先呈初稿；三校意见仍可参阅）\n', true);
        }
      }).catch(function () {
        if (attempt < 1) {
          callBook(bd, live || '', attempt + 1);
        } else {
          // 定稿未竟：全书退初稿
          finishWith(assembleBook(state.drafts) + '（定稿未竟，先呈初稿；三校意见仍可参阅）\n', true);
        }
      });
    }
  }

  function finalizeByChapter() {
    var finals = {};
    var notes = [];

    (function next(i) {
      if (i >= state.sections.length) {
        // 交代两类未竟：定稿未竟（沿用初稿，附失败原因分类）／起草未足配额
        var marks = [];
        if (notes.length) {
          var counts = {};
          notes.forEach(function (n) { counts[n.label] = (counts[n.label] || 0) + 1; });
          var detail = Object.keys(counts)
            .map(function (k) { return k + '×' + counts[k]; })
            .join('、');
          marks.push('其中 ' + notes.length + ' 节定稿未竟（' + detail + '），沿用初稿');
        }
        if (state.shortfalls.length) marks.push(state.shortfalls.length + ' 节起草未足配额');
        finishWith(
          assembleBook(finals) + (marks.length ? '（' + marks.join('；') + '）\n' : ''),
          marks.length > 0
        );
        return;
      }

      var sec = state.sections[i];
      // 口吻只取最近两节即可：越到后节 payload 越重，曾因此连锁超时。
      var finalized = state.sections.slice(Math.max(0, i - 2), i).map(function (s) {
        return { id: s.id, kind: s.kind, title: s.title, body: finals[s.id] || '' };
      });

      callChapter(sec, finalized, '', 0);

      function callChapter(sc, fz, seed, attempt) {
        var live = '';

        function fallbackDraft(label) {
          finals[sc.id] = trimDangling(state.drafts[sc.id] || '');
          notes.push({ title: sc.title, label: label || '未竟' });
          next(i + 1);
        }

        // 失败原因归类：Worker error 带上游状态码（如「模型应答异常（429）」），
        // 看门狗掐断则是「半晌没有动静／久候不至」。末试失败时据此入卷尾诊断。
        function failLabel(err) {
          var msg = String((err && err.message) || err || '');
          if (/429/.test(msg)) return '限流';
          var m = msg.match(/应答异常（(\d+)）/);
          if (m) return '上游' + m[1];
          if (/超时|半晌|久候|中断/.test(msg)) return '超时';
          return '未竟';
        }

        hengji.bookFinalSection({
          spirit: spiritEl.value.trim(),
          targetWords: state.target,
          scope: 'chapter',
          blueprint: lightBlueprint(),
          bookDraft: { title: state.blueprint.title, sections: draftSections() },
          finalized: fz,
          reviews: state.reviews,
          section: sc,
          seed: seed
        }, {
          onChunk: function (full) {
            live = full;
            var f2 = {};
            Object.keys(finals).forEach(function (id) { f2[id] = finals[id]; });
            f2[sc.id] = full;
            show(assembleBook(f2));
            outputEl.scrollTop = outputEl.scrollHeight;
          }
        }).then(function (r) {
          settle(canonicalBody(r.text, sc.title));
        }).catch(function (err) {
          if (attempt < 2) {
            var liveSeed = live.replace(/\s/g, '').length >= 200 ? canonicalBody(live, sc.title) : '';
            callChapter(sc, fz, liveSeed, attempt + 1);
          } else {
            fallbackDraft(failLabel(err));
          }
        });

        // 验收按目标份额 share（quota 已含余量）：≥份额九成、相对起草
        // 至多收一成五，悬尾先截；不达标带原流 seed 重试（共三试）。
        function settle(rawFinal) {
          var draftBody = state.drafts[sc.id] || '';
          var finalBody = trimDangling(rawFinal);
          var fChars = plainChars(finalBody);
          var dChars = plainChars(draftBody);
          var longEnough = fChars >= sc.share * 0.9 && fChars >= dChars * 0.85;

          if (!longEnough && attempt < 2) {
            callChapter(sc, fz, plainChars(rawFinal) >= 200 ? rawFinal : '', attempt + 1);
          } else if (longEnough) {
            finals[sc.id] = finalBody;
            next(i + 1);
          } else {
            fallbackDraft('定稿缩水');
          }
        }
      }
    })(0);
  }

  function finishWith(text, fellBack) {
    show(text);
    outputEl.scrollTop = 0;

    var chars = text.replace(/^\s*#{1,6}\s.*$/gm, '').replace(/\s/g, '').length;
    setMeta('final', '全书 ' + chars + ' 字' + (chars < state.target * 0.9 ? '（未足目标）' : ''));

    markStage('final', 'done');
    downloadBtn.removeAttribute('hidden');
    uiMode = 'done';
    setBtn(false, '再呈一部');
    setHint(fellBack
      ? '定稿未竟，已呈初稿；可下载初稿，「再呈一部」另起新卷'
      : '已成卷，可点「下载书卷」；「再呈一部」另起新卷');
  }

  /* ---------- 7. 下载书卷 ---------- */

  function bookName() {
    if (state && state.blueprint && state.blueprint.title) return state.blueprint.title;
    var text = outputEl.textContent;
    var m = text.match(/《([^》]{1,20})》/);
    if (m) return m[1].trim();
    m = text.match(/^#\s+(.{1,20})/m);
    if (m) return m[1].trim().replace(/[\\/:*?"<>|]/g, '');
    return '大儒呈作';
  }

  downloadBtn.addEventListener('click', function () {
    var text = outputEl.textContent;
    if (!text || downloadBtn.hasAttribute('hidden')) return;

    // BOM：让旧版 Windows 记事本也认得 UTF-8
    var blob = new Blob(['﻿', text], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = bookName() + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
})();
