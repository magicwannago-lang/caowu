/* ============================================================
   草屋 · 短剧编剧（衡几第六件器物）
   频率（男频/女频）+ 子类型 + 大概情节 → 企划（Worker）→ 分集大纲
   （Worker）→ 逐集剧本（SSE，字数闸＋扩写＋去AI味润色）。
   成稿只在浏览器内：可下载 Word / Markdown、可复制；
   不写 localStorage、不入 IndexedDB，关掉页面即散。
   类型清单与 worker/src/genres-drama.js 同 ID 同序，改一处要同步。
   ============================================================ */

(function () {
  'use strict';

  var hengji = window.Hengji;
  var Docx = window.DramaDocx;
  if (!hengji || !Docx) return;

  var $ = function (id) { return document.getElementById(id); };

  // 只取前端需要的 id + 名；套路/节拍等长材在 Worker 侧
  var GENRES = {
    male: [
      { id: 'niexi-dalian', name: '逆袭打脸' },
      { id: 'chongsheng-guilai', name: '重生归来' },
      { id: 'zhanshen-zhuixu', name: '战神赘婿' },
      { id: 'dushi-xiuxian', name: '都市修仙' },
      { id: 'bingwang-guilai', name: '兵王回归' },
      { id: 'shangye-diguo', name: '商业帝国' }
    ],
    female: [
      { id: 'tijia-tianchong', name: '替嫁甜宠' },
      { id: 'chongsheng-fuchou', name: '重生复仇' },
      { id: 'zhenjia-qianjin', name: '真假千金' },
      { id: 'haomen-nuelian', name: '豪门虐恋' },
      { id: 'daiqiu-pao', name: '带球跑' },
      { id: 'gugong-gongdou', name: '古言宫斗' }
    ]
  };
  var FREQ_LABEL = { male: '男频', female: '女频' };

  var CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
            '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];
  function cnNum(n) { return CN[n] || String(n); }
  function cnCount(s) { return String(s || '').replace(/\s/g, '').length; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  var els = {
    genres: $('dra-genres'),
    plot: $('dra-plot'),
    protagonist: $('dra-protagonist'),
    extra: $('dra-extra'),
    episodes: $('dra-episodes'),
    words: $('dra-words'),
    polish: $('dra-polish'),
    run: $('dra-run'),
    stop: $('dra-stop'),
    stages: $('dra-stages'),
    sheet: $('dra-sheet'),
    actions: $('dra-actions'),
    copy: $('dra-copy'),
    dlMd: $('dra-download-md'),
    dlWord: $('dra-download-word'),
    hint: $('dra-hint'),
    totalHint: $('dra-total-hint')
  };
  if (!els.plot || !els.run) return;

  // mode：idle | working | done | stopped
  var mode = 'idle';
  var state = null;
  var ac = null;
  var freq = 'male';
  var genreId = GENRES.male[0].id;

  /* ---------------- 频率与类型 ---------------- */

  function freqRadios() {
    return document.querySelectorAll('input[name="dra-freq"]');
  }

  function renderGenres() {
    els.genres.textContent = '';
    GENRES[freq].forEach(function (g) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dra-genre' + (g.id === genreId ? ' is-on' : '');
      b.textContent = g.name;
      b.dataset.id = g.id;
      b.setAttribute('aria-pressed', g.id === genreId ? 'true' : 'false');
      b.addEventListener('click', function () {
        genreId = g.id;
        els.genres.querySelectorAll('.dra-genre').forEach(function (x) {
          var on = x === b;
          x.classList.toggle('is-on', on);
          x.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
      });
      els.genres.appendChild(b);
    });
  }

  freqRadios().forEach(function (r) {
    r.addEventListener('change', function () {
      if (!r.checked) return;
      freq = r.value === 'female' ? 'female' : 'male';
      genreId = GENRES[freq][0].id;
      renderGenres();
    });
  });
  renderGenres();

  function updateTotalHint() {
    var n = Number(els.episodes.value) || 0;
    var w = Number(els.words.value) || 0;
    els.totalHint.textContent = (n > 0 && w > 0)
      ? '约 ' + (w * n).toLocaleString() + ' 字（' + w + ' × ' + n + ' 集）'
      : '';
  }
  els.episodes.addEventListener('input', updateTotalHint);
  els.words.addEventListener('input', updateTotalHint);
  updateTotalHint();

  /* ---------------- 阶段条 ---------------- */

  function stageLi(stage) { return els.stages.querySelector('li[data-stage="' + stage + '"]'); }
  function markStage(stage, cls) {
    var li = stageLi(stage);
    if (!li) return;
    li.classList.remove('is-active', 'is-done');
    if (cls) li.classList.add(cls === 'active' ? 'is-active' : 'is-done');
  }
  function stageMeta(stage, text, warn) {
    var el = $('dra-' + stage + '-meta');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-warn', !!warn);
  }
  function clearStages() {
    els.stages.removeAttribute('hidden');
    els.stages.querySelectorAll('li').forEach(function (li) {
      li.classList.remove('is-active', 'is-done');
    });
    ['premise', 'outline', 'draft', 'polish'].forEach(function (s) { stageMeta(s, ''); });
  }

  /* ---------------- 成稿陈位 ---------------- */

  var planBox = null;
  var epBoxes = {}; // index → { box, metaEl, scriptEl, buf, stage }

  function resetSheet() {
    els.sheet.textContent = '';
    els.sheet.removeAttribute('hidden');
    planBox = null;
    epBoxes = {};
  }

  function renderPlan(premise, outline) {
    planBox = document.createElement('div');
    planBox.className = 'emo-plan dra-plan';
    var people = (premise.characters || []).map(function (c) {
      return esc(c.name) + '（' + esc(c.role || c.archetype || '') + '）';
    }).join('、');
    var points = (premise.sellingPoints || []).map(function (x) {
      return '<li>' + esc(x) + '</li>';
    }).join('');
    var eps = outline.episodes.map(function (e) {
      return cnNum(e.index) + '·' + esc(e.title);
    }).join('　');
    planBox.innerHTML =
      '<p class="emo-plan-title">《' + esc(premise.title) + '》' +
      '<span class="emo-plan-name">' + esc(FREQ_LABEL[state.input.freq]) + '·' + esc(premise.genre || '') + '</span></p>' +
      (premise.logline ? '<p class="emo-plan-line">' + esc(premise.logline) + '</p>' : '') +
      (premise.centralConflict ? '<p class="emo-plan-meta">冲突：' + esc(premise.centralConflict) + '</p>' : '') +
      '<p class="emo-plan-meta">人物：' + esc(people || '—') + '</p>' +
      (premise.emotionArc ? '<p class="emo-plan-meta">节奏：' + esc(premise.emotionArc) + '</p>' : '') +
      (points ? '<ul class="emo-plan-rules">' + points + '</ul>' : '') +
      '<p class="emo-plan-meta">集目：' + eps + '</p>';
    els.sheet.appendChild(planBox);
  }

  function addEpisodeBox(index, title, target) {
    var box = document.createElement('article');
    box.className = 'emo-ch dra-ep';
    box.innerHTML =
      '<h4 class="emo-ch-title">' +
      '<span class="emo-ch-seq">第' + cnNum(index) + '集</span>' + esc(title) +
      '<span class="emo-ch-meta"></span></h4>' +
      '<div class="dra-script"></div>';
    els.sheet.appendChild(box);
    var rec = {
      box: box,
      metaEl: box.querySelector('.emo-ch-meta'),
      scriptEl: box.querySelector('.dra-script'),
      buf: '',
      stage: 'draft'
    };
    rec.metaEl.textContent = '目标约 ' + target + ' 字';
    epBoxes[index] = rec;
    els.sheet.scrollTop = els.sheet.scrollHeight;
    return rec;
  }

  // 润色流可能把原稿用 <<<DRAFT ... DRAFT>>> 包裹（服务端收齐后才剥），
  // 前端边收边把首尾标记（含跨块的半段标记）藏掉。
  var DRAFT_HEAD = '<<<DRAFT';
  var DRAFT_TAIL = 'DRAFT>>>';

  function commonAffixLen(s, marker, atHead) {
    var n = Math.min(s.length, marker.length);
    var k = 0;
    while (k < n) {
      var si = atHead ? k : s.length - 1 - k;
      var mi = atHead ? k : marker.length - 1 - k;
      if (s[si] !== marker[mi]) break;
      k++;
    }
    return k;
  }

  function stripDraftWrap(raw) {
    var s = raw;
    if (s.startsWith(DRAFT_HEAD)) {
      s = s.slice(DRAFT_HEAD.length).replace(/^[ \t]*\n?/, '');
    } else if (commonAffixLen(s, DRAFT_HEAD, true) === s.length) {
      s = '';
    }
    if (s.endsWith(DRAFT_TAIL)) {
      s = s.slice(0, s.length - DRAFT_TAIL.length);
    } else {
      var t = commonAffixLen(s, DRAFT_TAIL, false);
      var tailSeg = t > 0 ? s.slice(s.length - t) : '';
      if (t > 0 && DRAFT_TAIL.startsWith(tailSeg)) s = s.slice(0, s.length - t);
    }
    return s;
  }

  /* ---------------- 剧本行高亮（与 DramaDocx.classifyLine 同规） ---------------- */

  function highlightHtml(text) {
    var html = [];
    String(text || '').split('\n').forEach(function (rawLine) {
      var c = Docx.classifyLine(rawLine);
      if (c.kind === 'blank') { html.push('<p class="dra-l-blank"></p>'); return; }
      if (c.kind === 'scene') { html.push('<p class="dra-l-scene">' + esc(c.text) + '</p>'); return; }
      if (c.kind === 'eptitle') { html.push('<p class="dra-l-eptitle">' + esc(c.text) + '</p>'); return; }
      if (c.kind === 'action') { html.push('<p class="dra-l-action">' + esc(c.text) + '</p>'); return; }
      if (c.kind === 'narration') {
        html.push('<p class="dra-l-line"><span class="dra-l-speaker">旁白：</span>'
          + '<span class="dra-l-dialogue">' + esc(c.text) + '</span></p>');
        return;
      }
      if (c.kind === 'speaker') {
        html.push('<p class="dra-l-line"><span class="dra-l-speaker">' + esc(c.speaker) + '</span>'
          + '<span class="dra-l-dialogue">' + esc(c.text) + '</span></p>');
        return;
      }
      html.push('<p class="dra-l-normal">' + esc(c.text) + '</p>');
    });
    return html.join('');
  }

  function renderScript(rec) {
    rec.scriptEl.innerHTML = highlightHtml(rec.visible);
  }

  function appendPiece(rec, piece) {
    rec.buf += piece;
    if (rec.stage === 'polish') {
      rec.visible = stripDraftWrap(rec.buf);
    } else {
      var m = rec.buf.match(/SCRIPT[:：]?[ \t]*\n?/);
      if (!m) return;
      rec.visible = rec.buf.slice(m.index + m[0].length);
    }
    renderScript(rec);
  }

  function clearScript(rec, stage) {
    rec.stage = stage;
    rec.buf = '';
    rec.visible = '';
    rec.scriptEl.textContent = '';
  }

  // 模型稿首行常自带「第X集 标题」，与盒题、Word/Markdown 的集标题重复，定稿剥去
  var EP_TITLE_HEAD = /^[ \t　]*第[\d一二三四五六七八九十百]+集[ \t　]*[^\n]*(?:\r?\n|$)/;
  function stripEpTitle(text) {
    return String(text || '').replace(EP_TITLE_HEAD, '').replace(/^[ \t]*\n+/, '');
  }

  function setEpisodeFinal(rec, ep) {
    rec.visible = ep.script || '';
    renderScript(rec);
    rec.metaEl.textContent = ep.chars + ' 字'
      + (ep.polished ? '·已润色' : '')
      + (ep.target && ep.chars < Math.round(ep.target * 0.8) ? '（未足目标）' : '');
    rec.metaEl.classList.toggle('is-warn', !!(ep.target && ep.chars < Math.round(ep.target * 0.8)));
  }

  /* ---------------- 输入读取 ---------------- */

  function readInput() {
    return {
      freq: freq,
      genre: genreId,
      plot: els.plot.value.trim(),
      protagonist: els.protagonist.value.trim(),
      extra: els.extra.value.trim(),
      episodes: Number(els.episodes.value) || 5,
      wordsPerEpisode: Number(els.words.value) || 800,
      polish: els.polish.checked
    };
  }

  function lastSentence(text) {
    var parts = String(text || '').split(/(?<=[。！？!?…；;])/).map(function (s) {
      return s.trim();
    }).filter(Boolean);
    return (parts[parts.length - 1] || '').slice(0, 100);
  }

  /* ---------------- 总流程 ---------------- */

  function setRunning(r) {
    mode = r ? 'working' : mode;
    els.run.disabled = r;
    els.run.textContent = r ? '编剧走笔中…' : '请编剧落笔';
    els.stop.hidden = !r;
    if (r) els.stop.textContent = '停笔';
    [els.plot, els.protagonist, els.extra, els.episodes, els.words].forEach(function (el) {
      el.disabled = r;
    });
    els.polish.disabled = r;
    freqRadios().forEach(function (radio) { radio.disabled = r; });
    els.genres.querySelectorAll('button').forEach(function (b) { b.disabled = r; });
  }

  function showActions(show) { els.actions.hidden = !show; }

  function skeleton() {
    return [
      '【编剧今日不在，先给你一副搭架子，自己慢慢填】',
      '',
      '一、企划（先把骨架立住）',
      '　标题：',
      '　一句话梗概：谁，在什么处境里，要翻盘/相守什么',
      '　主线冲突：谁和谁、因为什么、悬而未决的是什么',
      '　人物四到六个：主角（性格＋口头禅/标志动作）、对手、关键配角，各写一条弧光',
      '',
      '二、分集大纲（一集一个核心事件＋一个钩子）',
      '　第1集：三十秒内进冲突——受辱/误会/悬念，开场就要抓人',
      '　中段：事件不重复，底牌一层层揭，每集结尾留悬念（男频反转打脸 / 女频虐甜转折）',
      '　末集：收束主线冲突，各人结局交代清楚',
      '',
      '三、剧本规矩（编剧在时也是这几条）',
      '　场景：【场景 · 地点 · 时间（日/夜）】',
      '　动作：（用圆括号包裹，写具体动作，不写抽象形容）',
      '　台词：角色名：台词；旁白：旁白内容',
      '　台词要口语、像人说的；“然而/与此同时/不是…而是…”这类 AI 腔划掉。',
      '',
      '填完可再点一次「请编剧落笔」。'
    ].join('\n');
  }

  function failAll(msg) {
    mode = 'idle';
    setRunning(false);
    els.sheet.textContent = skeleton();
    stageMeta('premise', '未应答', true);
    els.hint.textContent = '编剧不在（' + msg + '）；架子在此，稍后再试';
  }

  function stopHere(msg) {
    mode = 'stopped';
    setRunning(false);
    els.run.textContent = '再写一部';
    els.hint.textContent = msg;
    showActions(state.episodes.filter(Boolean).length > 0);
  }

  function start() {
    if (mode === 'working') return;

    var input = readInput();
    if (!input.plot) {
      els.sheet.removeAttribute('hidden');
      els.sheet.textContent = '先写下大概情节——一句话也行，编剧据此拓展企划、排布分集。';
      return;
    }

    state = { input: input, premise: null, outline: null, episodes: [], polishedCount: 0 };
    ac = new AbortController();
    mode = 'working';
    setRunning(true);
    showActions(false);
    clearStages();
    resetSheet();
    els.hint.textContent = '编剧正在拓展企划…';

    if (!input.polish) {
      markStage('polish', 'done');
      stageMeta('polish', '未开润色');
    }

    markStage('premise', 'active');
    hengji.dramaPremise(input, ac.signal).then(function (premise) {
      state.premise = premise;
      stageMeta('premise', '《' + premise.title + '》');
      markStage('premise', 'done');
      markStage('outline', 'active');
      els.hint.textContent = '企划已成，正在排布分集…';
      return hengji.dramaOutline(input, premise, ac.signal);
    }).then(function (outline) {
      state.outline = outline;
      renderPlan(state.premise, outline);
      stageMeta('outline', outline.episodes.length + ' 集');
      markStage('outline', 'done');
      markStage('draft', 'active');
      if (input.polish) markStage('polish', 'active');
      return loopEpisodes(0);
    }).catch(function (err) {
      if (err && err.name === 'AbortError') {
        stopHere('已停笔；已成的集可下载');
      } else {
        failAll((err && err.message) || '连接失败');
      }
    });
  }

  function loopEpisodes(i) {
    var outline = state.outline;
    if (ac.signal.aborted) {
      var e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (i >= outline.episodes.length) return finishAll();

    var ep = outline.episodes[i];
    var rec = addEpisodeBox(ep.index, ep.title, ep.wordTarget);
    var prev = state.episodes[i - 1];
    var recap = prev
      ? '第' + prev.index + '集：' + (prev.summary || prev.beat || '')
        + '（结束于：' + lastSentence(prev.script) + '）'
      : '';
    stageMeta('draft', '第 ' + (i + 1) + ' / ' + outline.episodes.length + ' 集 · ' + ep.title);
    els.hint.textContent = '正在写第 ' + (i + 1) + ' 集「' + ep.title + '」…';

    return writeEpisode(ep, recap, rec, 0).then(function (record) {
      state.episodes[i] = record;
      return loopEpisodes(i + 1);
    });
  }

  // 单集两试：流中断等意外重来一次；两试不成则全剧停在此集，已成集仍可下载。
  function writeEpisode(ep, recap, rec, attempt) {
    var signal = ac.signal;

    return hengji.dramaEpisode({
      input: state.input,
      premise: state.premise,
      episode: ep,
      recap: recap
    }, {
      signal: ac.signal,
      onStage: function (stage, ev) {
        if (stage === 'expand') {
          clearScript(rec, 'expand');
          rec.metaEl.textContent = '扩写第 ' + ev.round + ' 轮（' + (ev.chars || 0) + '/' + ev.target + ' 字）';
        } else if (stage === 'polish') {
          clearScript(rec, 'polish');
          rec.metaEl.textContent = '去AI味润色中…';
          markStage('polish', 'active');
        }
      },
      onPiece: function (piece) {
        appendPiece(rec, piece);
        els.sheet.scrollTop = els.sheet.scrollHeight;
      },
      onProgress: function (chars) {
        if (rec.stage !== 'polish' && chars) {
          rec.metaEl.textContent = chars + ' / ' + ep.wordTarget + ' 字';
        }
      }
    }).then(function (done) {
      var record = {
        index: ep.index,
        title: ep.title,
        beat: ep.beat || '',
        hook: ep.hook || '',
        summary: done.summary || '',
        script: stripEpTitle(done.script),
        chars: done.chars,
        target: done.target,
        polished: done.polished
      };
      setEpisodeFinal(rec, record);
      els.sheet.scrollTop = els.sheet.scrollHeight;
      return record;
    }, function (err) {
      if (signal && signal.aborted) {
        // 停笔时正在写的集也算数：残稿入册，可与已成集一并下载
        var partial = stripEpTitle(rec.visible || '');
        var rec0 = {
          index: ep.index,
          title: ep.title,
          beat: ep.beat || '',
          hook: ep.hook || '',
          summary: '',
          script: partial,
          chars: cnCount(partial),
          target: ep.wordTarget,
          polished: false
        };
        state.episodes[ep.index - 1] = rec0;
        setEpisodeFinal(rec, rec0);
        rec.metaEl.textContent = rec0.chars + ' 字（已停笔）';
        rec.metaEl.classList.add('is-warn');
        var e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      if (attempt < 1) {
        clearScript(rec, 'draft');
        rec.metaEl.textContent = '重试中…';
        return writeEpisode(ep, recap, rec, attempt + 1);
      }
      throw err;
    }).then(function (record) {
      if (record.polished) {
        state.polishedCount = (state.polishedCount || 0) + 1;
        stageMeta('polish', state.polishedCount + ' 集已润色');
      }
      // 润色阶段贯穿逐集循环，全部完成由 finishAll 标 done
      if (state.input.polish) markStage('polish', 'active');
      return record;
    });
  }

  function finishAll() {
    var total = state.episodes.reduce(function (n, e) { return n + (e.chars || 0); }, 0);
    state.totalChars = total;
    markStage('draft', 'done');
    markStage('polish', 'done');
    stageMeta('draft', state.episodes.length + ' 集 · ' + total + ' 字');
    if (state.input.polish) stageMeta('polish', state.polishedCount + ' 集已润色');
    mode = 'done';
    setRunning(false);
    els.run.textContent = '再写一部';
    els.hint.textContent = '成稿在此；只可下载与复制，草屋不留存';
    showActions(true);
    els.sheet.scrollTop = 0;
  }

  els.run.addEventListener('click', start);
  els.stop.addEventListener('click', function () {
    if (ac) ac.abort();
    els.stop.textContent = '停笔中…';
    setTimeout(function () { els.stop.textContent = '停笔'; }, 1500);
  });

  /* ---------------- 下载与复制 ---------------- */

  function exportCtx() {
    return {
      input: {
        freqLabel: FREQ_LABEL[state.input.freq],
        genreLabel: (state.premise && state.premise.genre) || '',
        wordsPerEpisode: state.input.wordsPerEpisode
      },
      premise: state.premise,
      episodes: state.episodes.map(function (e) {
        return {
          index: e.index, title: e.title, beat: e.beat, hook: e.hook,
          summary: e.summary, script: e.script, chars: e.chars
        };
      }),
      totalChars: state.totalChars || state.episodes.reduce(function (n, e) {
        return n + (e.chars || 0);
      }, 0)
    };
  }

  function baseName(ctx) {
    return Docx.slugify((ctx.premise && ctx.premise.title) || '短剧', '短剧');
  }

  els.dlWord.addEventListener('click', function () {
    if (!state || !state.episodes.length) return;
    var ctx = exportCtx();
    Docx.download(Docx.buildDocxBlob(ctx), baseName(ctx) + '.docx');
  });

  els.dlMd.addEventListener('click', function () {
    if (!state || !state.episodes.length) return;
    var ctx = exportCtx();
    var blob = new Blob([Docx.buildMarkdown(ctx)], { type: 'text/markdown;charset=utf-8' });
    Docx.download(blob, baseName(ctx) + '.md');
  });

  els.copy.addEventListener('click', function () {
    if (!state || !state.episodes.length) return;
    var md = Docx.buildMarkdown(exportCtx());
    var btn = els.copy;
    function ok() {
      var old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(function () { btn.textContent = old; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(md).then(ok, function () { fallbackCopy(md); ok(); });
    } else {
      fallbackCopy(md); ok();
    }
  });

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
    document.body.removeChild(ta);
  }
})();
