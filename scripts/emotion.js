/* ============================================================
   草屋 · 情感本写手（衡几第五件器物）
   文笔风格 + 风格要求 → 风格契约（Worker）→ 大纲（Worker）→
   逐章成稿（SSE，字数闸＋扩写＋本地AI味检测＋违规润色）。
   成稿只在浏览器内：可下载 Word / Markdown、可复制；
   不写 localStorage、不入 IndexedDB，关掉页面即散。
   ============================================================ */

(function () {
  'use strict';

  var hengji = window.Hengji;
  var Docx = window.EmotionDocx;
  if (!hengji) return;

  var $ = function (id) { return document.getElementById(id); };

  var PRESETS = [
    { name: '虐心催泪', style: '第一人称回望式叙述，细腻克制，善用日常细节和留白，平静的表面下情绪暗涌，结尾轻但有余震', requirements: '以短句为主；每章结尾留白不点破；避免成语堆砌与网络用语；核心意象反复出现形成前后呼应' },
    { name: '治愈温暖', style: '温柔舒缓的第三人称视角，节奏缓慢，多用生活化的温暖场景与食物、光线等细节', requirements: '句子长短交替，读起来松弛；多用具体小物承载情绪；不苦情堆砌；每章落在一个暖意细节上收尾' },
    { name: '清冷文艺', style: '疏离冷静的观察者口吻，意象化表达，情绪全部藏在物象与动作里', requirements: '短段落；慎用形容词，动词要准；不出现直陈情绪的句子；克制使用「爱」「心疼」等词' },
    { name: '炽烈浓烈', style: '浓烈直接的第二人称倾诉，情绪饱满外放，节奏快', requirements: '长句推进但情绪顶点切短句；排比不超过连续两句；每章有一个明确的情绪峰值' },
    { name: '剧本杀本', style: '多视角轮换的剧本体，每幕以场景动作与对白推进，情绪在幕末收束成独白', requirements: '每幕开头给场景提示；对白单独成行；独白克制而有爆发点；章末留落泪钩子', genre: '剧本杀情感本' }
  ];

  var CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
  function cnNum(n) { return CN[n] || String(n); }
  function cnCount(s) { return String(s || '').replace(/\s/g, '').length; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  var els = {
    presets: $('emo-presets'),
    style: $('emo-style'),
    requirements: $('emo-requirements'),
    genre: $('emo-genre'),
    theme: $('emo-theme'),
    chapters: $('emo-chapters'),
    words: $('emo-words'),
    pov: $('emo-pov'),
    mood: $('emo-mood'),
    taboo: $('emo-taboo'),
    deflavor: $('emo-deflavor'),
    run: $('emo-run'),
    stop: $('emo-stop'),
    stages: $('emo-stages'),
    sheet: $('emo-sheet'),
    actions: $('emo-actions'),
    copy: $('emo-copy'),
    dlMd: $('emo-download-md'),
    dlWord: $('emo-download-word'),
    hint: $('emo-hint'),
    totalHint: $('emo-total-hint')
  };
  if (!els.style || !els.run) return;

  // mode：idle | working | done | stopped
  var mode = 'idle';
  var state = null;
  var ac = null;

  /* ---------------- 预设与小交互 ---------------- */

  PRESETS.forEach(function (p) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'emo-chip';
    b.textContent = p.name;
    b.addEventListener('click', function () {
      els.style.value = p.style;
      els.requirements.value = p.requirements;
      if (p.genre) {
        for (var i = 0; i < els.genre.options.length; i++) {
          if (els.genre.options[i].text === p.genre) els.genre.selectedIndex = i;
        }
      }
    });
    els.presets.appendChild(b);
  });

  function updateTotalHint() {
    var n = Number(els.chapters.value) || 0;
    var w = Number(els.words.value) || 0;
    els.totalHint.textContent = (n > 0 && w > 0)
      ? '约 ' + (w * n).toLocaleString() + ' 字（' + w + ' × ' + n + ' 章）'
      : '';
  }
  els.chapters.addEventListener('input', updateTotalHint);
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
    var el = $('emo-' + stage + '-meta');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('is-warn', !!warn);
  }
  function clearStages() {
    els.stages.removeAttribute('hidden');
    els.stages.querySelectorAll('li').forEach(function (li) {
      li.classList.remove('is-active', 'is-done');
    });
    ['contract', 'outline', 'draft', 'polish'].forEach(function (s) { stageMeta(s, ''); });
  }

  /* ---------------- 成稿陈位 ---------------- */

  var planBox = null;   // 契约 + 大纲淡字块
  var chBoxes = {};     // index → { box, proseEl, violEl, buf, stage }

  function resetSheet() {
    els.sheet.textContent = '';
    els.sheet.removeAttribute('hidden');
    planBox = null;
    chBoxes = {};
  }

  function renderPlan(contract, outline) {
    planBox = document.createElement('div');
    planBox.className = 'emo-plan';
    var rules = (contract.hardRules || []).map(function (r) {
      return '<li>' + esc(r) + '</li>';
    }).join('');
    var people = (outline.characters || []).map(function (c) {
      return esc(c.name) + '（' + esc(c.role) + '）';
    }).join('、');
    var chs = outline.chapters.map(function (c) {
      return cnNum(c.index) + '·' + esc(c.title);
    }).join('　');
    planBox.innerHTML =
      '<p class="emo-plan-title">《' + esc(outline.title) + '》' +
      '<span class="emo-plan-name">' + esc(contract.name || '') + '</span></p>' +
      (outline.logline ? '<p class="emo-plan-line">' + esc(outline.logline) + '</p>' : '') +
      '<p class="emo-plan-meta">人物：' + esc(people || '—') + '</p>' +
      '<p class="emo-plan-meta">章目：' + chs + '</p>' +
      '<ul class="emo-plan-rules">' + rules + '</ul>';
    els.sheet.appendChild(planBox);
  }

  function addChapterBox(index, title, target) {
    var box = document.createElement('article');
    box.className = 'emo-ch';
    box.innerHTML =
      '<h4 class="emo-ch-title">' +
      '<span class="emo-ch-seq">第' + cnNum(index) + '章</span>' + esc(title) +
      '<span class="emo-ch-meta"></span></h4>' +
      '<div class="emo-ch-prose"></div>' +
      '<p class="emo-ch-viol"></p>';
    els.sheet.appendChild(box);
    var rec = {
      box: box,
      metaEl: box.querySelector('.emo-ch-meta'),
      proseEl: box.querySelector('.emo-ch-prose'),
      violEl: box.querySelector('.emo-ch-viol'),
      buf: '',
      stage: 'draft'
    };
    rec.metaEl.textContent = '目标约 ' + target + ' 字';
    chBoxes[index] = rec;
    els.sheet.scrollTop = els.sheet.scrollHeight;
    return rec;
  }

  // 起草 / 扩写流带 SUMMARY/PROSE 头，只渲染 PROSE 之后；
  // 润色流被 <<<DRAFT ... DRAFT>>> 包裹（服务端收齐后才剥），
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
      s = ''; // 头部标记只到一半
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

  function appendPiece(rec, piece) {
    rec.buf += piece;
    if (rec.stage === 'polish') {
      rec.proseEl.textContent = stripDraftWrap(rec.buf);
      return;
    }
    var m = rec.buf.match(/PROSE[:：][ \t]*\n?/);
    if (!m) return;
    rec.proseEl.textContent = rec.buf.slice(m.index + m[0].length);
  }

  function clearProse(rec, stage) {
    rec.stage = stage;
    rec.buf = '';
    rec.proseEl.textContent = '';
    rec.violEl.textContent = '';
    rec.violEl.className = 'emo-ch-viol';
  }

  function setChapterFinal(rec, ch) {
    rec.proseEl.textContent = '';
    String(ch.prose || '').split(/\n{2,}/).map(function (p) {
      return p.replace(/\s*\n\s*/g, ' ').trim();
    }).filter(Boolean).forEach(function (p) {
      var para = document.createElement('p');
      para.textContent = p;
      rec.proseEl.appendChild(para);
    });
    rec.metaEl.textContent = ch.chars + ' 字' +
      (ch.target && ch.chars < Math.round(ch.target * 0.85) ? '（未足目标）' : '');
    rec.metaEl.classList.toggle('is-warn', ch.target && ch.chars < Math.round(ch.target * 0.85));

    var before = (ch.before && ch.before.violations) || [];
    var after = (ch.after && ch.after.violations) || [];
    if (after.length) {
      rec.violEl.classList.add('is-warn');
      rec.violEl.textContent = '仍存：' + after.slice(0, 4)
        .map(function (v) { return v.name + '×' + v.count; }).join('；');
    } else if (before.length) {
      rec.violEl.classList.add('is-ok');
      rec.violEl.textContent = '已消除 ' + before.length + ' 类 AI 味痕迹';
    } else {
      rec.violEl.classList.add('is-ok');
      rec.violEl.textContent = 'AI 味检测通过';
    }
  }

  /* ---------------- 输入读取 ---------------- */

  function readInput() {
    return {
      style: els.style.value.trim(),
      requirements: els.requirements.value.trim(),
      genre: els.genre.value,
      theme: els.theme.value.trim(),
      chapters: Number(els.chapters.value) || 3,
      wordsPerChapter: Number(els.words.value) || 600,
      pov: els.pov.value.trim(),
      mood: els.mood.value.trim(),
      taboo: els.taboo.value.trim(),
      deflavor: els.deflavor.checked
    };
  }

  function lastSentences(text, n) {
    var parts = String(text || '').split(/(?<=[。！？!?…；;])/).map(function (s) {
      return s.trim();
    }).filter(Boolean);
    return parts.slice(-n).join('').slice(0, 80);
  }

  function lightOutline(o) {
    return {
      title: o.title,
      logline: o.logline,
      centralConflict: o.centralConflict,
      resolution: o.resolution,
      characters: o.characters
    };
  }

  /* ---------------- 总流程 ---------------- */

  function setRunning(r) {
    mode = r ? 'working' : mode;
    els.run.disabled = r;
    els.run.textContent = r ? '写手写笔中…' : '请写手落笔';
    els.stop.hidden = !r;
    if (r) els.stop.textContent = '停笔';
    [els.style, els.requirements, els.theme, els.chapters, els.words, els.pov, els.mood, els.taboo]
      .forEach(function (el) { el.disabled = r; });
    els.genre.disabled = r;
    els.deflavor.disabled = r;
    els.presets.querySelectorAll('button').forEach(function (b) { b.disabled = r; });
  }

  function showActions(show) {
    els.actions.hidden = !show;
  }

  function skeleton(input) {
    return [
      '【写手今日不在，先给你一副著文框架，自己慢慢填】',
      '',
      '一、风格契约（先立规矩，再动笔）',
      '　视角与人称：',
      '　句式节奏（长短／平均句长／段落习惯）：',
      '　词汇倾向：提倡　　　　；回避　　　　',
      '　意象库（至少四个）：',
      '　情绪走向（用 → 连接）：',
      '　硬规则（三至八条，逐条可校验）：',
      '',
      '二、大纲（情绪服务于故事，不能只有氛围）',
      '　书名：《　　　　》',
      '　主线冲突：谁和谁之间，悬而未决的是什么',
      '　人物：',
      '　第一章（交代人物、关系、处境）：',
      '　中段各章（每章推进主线，埋悬念并回收）：',
      '　末章（揭开悬念，关系走向明确）：',
      '',
      '三、成稿规矩（写手在时也是这几条）',
      '　1. 情绪不直陈，用动作、物象、天气代替；',
      '　2. 长短句交错，段落不等长，排比不过两句；',
      '　3. 结尾不升华、不总结，末句落在物象或动作上；',
      '　4. 写完读出声：像人说的话留下，像机器说的话划掉。',
      '',
      '填完可再点一次「请写手落笔」。'
    ].join('\n');
  }

  function failAll(msg) {
    mode = 'idle';
    setRunning(false);
    els.sheet.textContent = skeleton(state && state.input);
    stageMeta('contract', '未应答', true);
    els.hint.textContent = '写手不在（' + msg + '）；框架在此，稍后再试';
  }

  function stopHere(msg) {
    mode = 'stopped';
    setRunning(false);
    els.run.textContent = '再写一篇';
    els.hint.textContent = msg;
    showActions(state.chapters.filter(Boolean).length > 0);
  }

  function start() {
    if (mode === 'working') return;

    var input = readInput();
    if (!input.style || !input.requirements) {
      els.sheet.removeAttribute('hidden');
      els.sheet.textContent = '先写下文笔风格与风格要求——两句主观的话就行，写手据此编译风格契约。';
      return;
    }

    state = { input: input, contract: null, outline: null, chapters: [], polishedCount: 0 };
    ac = new AbortController();
    mode = 'working';
    setRunning(true);
    showActions(false);
    clearStages();
    resetSheet();
    els.hint.textContent = '写手正在编译风格契约…';

    markStage('contract', 'active');
    hengji.emotionContract(input, ac.signal).then(function (contract) {
      state.contract = contract;
      stageMeta('contract', contract.name || '已成契');
      markStage('contract', 'done');
      markStage('outline', 'active');
      els.hint.textContent = '契约已立，正在排布大纲…';
      return hengji.emotionOutline(input, contract, ac.signal);
    }).then(function (outline) {
      state.outline = outline;
      renderPlan(state.contract, outline);
      stageMeta('outline', '《' + outline.title + '》' + outline.chapters.length + ' 章');
      markStage('outline', 'done');
      markStage('draft', 'active');
      return loopChapters(0);
    }).catch(function (err) {
      if (err && err.name === 'AbortError') {
        stopHere('已停笔；已成的章节可下载');
      } else {
        failAll((err && err.message) || '连接失败');
      }
    });
  }

  function loopChapters(i) {
    var outline = state.outline;
    if (ac.signal.aborted) {
      var e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (i >= outline.chapters.length) return finishAll();

    var ch = outline.chapters[i];
    var rec = addChapterBox(ch.index, ch.title, ch.wordTarget);
    var prev = state.chapters[i - 1];
    var recap = prev
      ? ((prev.beat ? prev.beat + '。' : '') +
         (prev.summary || '') + '上一章结束于：' + lastSentences(prev.prose, 2))
      : '';
    stageMeta('draft', '第 ' + (i + 1) + ' / ' + outline.chapters.length + ' 章 · ' + ch.title);
    els.hint.textContent = '正在写第 ' + (i + 1) + ' 章「' + ch.title + '」…';

    return writeChapter(ch, recap, rec, 0).then(function (record) {
      state.chapters[i] = record;
      return loopChapters(i + 1);
    });
  }

  // 单章两试：流中断等意外重来一次；两试不成则全书停在此章，已成章仍可下载。
  function writeChapter(ch, recap, rec, attempt) {
    var signal = ac.signal;
    var polishedSeen = false;

    return hengji.emotionChapter({
      input: state.input,
      contract: state.contract,
      outlineLight: lightOutline(state.outline),
      chapter: ch,
      recap: recap
    }, {
      signal: ac.signal,
      onStage: function (stage, ev) {
        if (stage === 'expand') {
          clearProse(rec, 'expand');
          rec.metaEl.textContent = '扩写第 ' + ev.round + ' 轮（' + (ev.chars || 0) + '/' + ev.target + ' 字）';
        } else if (stage === 'polish') {
          polishedSeen = true;
          clearProse(rec, 'polish');
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
          rec.metaEl.textContent = chars + ' / ' + ch.wordTarget + ' 字';
        }
      }
    }).then(function (done) {
      var record = {
        index: ch.index,
        title: ch.title,
        beat: ch.beat || '',
        summary: done.summary || '',
        prose: done.prose,
        chars: done.chars,
        target: done.target,
        polished: done.polished,
        before: done.before,
        after: done.after
      };
      setChapterFinal(rec, record);
      els.sheet.scrollTop = els.sheet.scrollHeight;
      return record;
    }, function (err) {
      if (signal && signal.aborted) {
        var e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }
      if (attempt < 1) {
        clearProse(rec, 'draft');
        rec.metaEl.textContent = '重试中…';
        return writeChapter(ch, recap, rec, attempt + 1);
      }
      throw err;
    }).then(function (record) {
      if (record.polished) state.polishedCount = (state.polishedCount || 0) + 1;
      if (polishedSeen) {
        markStage('polish', 'done');
        stageMeta('polish', state.polishedCount + ' 章经润色');
      }
      return record;
    });
  }

  function finishAll() {
    var total = state.chapters.reduce(function (n, c) { return n + (c.chars || 0); }, 0);
    state.totalChars = total;
    markStage('draft', 'done');
    markStage('polish', 'done');
    stageMeta('draft', state.chapters.length + ' 章 · ' + total + ' 字');
    mode = 'done';
    setRunning(false);
    els.run.textContent = '再写一篇';
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

  function protagonist() {
    var chars = (state.outline && state.outline.characters) || [];
    var lead = chars.filter(function (c) { return /主角/.test(c.role || ''); })[0];
    var who = lead || chars[0];
    return who ? who.name : '';
  }

  function exportCtx() {
    return {
      meta: {
        title: state.outline.title,
        protagonist: protagonist(),
        theme: state.input.theme || state.outline.logline || '',
        genre: state.input.genre,
        style: state.input.style
      },
      chapters: state.chapters.map(function (c) {
        return { index: c.index, title: c.title, prose: c.prose };
      }),
      totalChars: state.totalChars || state.chapters.reduce(function (n, c) {
        return n + (c.chars || 0);
      }, 0)
    };
  }

  function baseName(ctx) {
    return Docx.slugify(ctx.meta.title, '情感本');
  }

  els.dlWord.addEventListener('click', function () {
    if (!state || !state.chapters.length) return;
    var ctx = exportCtx();
    Docx.download(Docx.buildDocxBlob(ctx), baseName(ctx) + '.docx');
  });

  els.dlMd.addEventListener('click', function () {
    if (!state || !state.chapters.length) return;
    var ctx = exportCtx();
    var blob = new Blob([Docx.buildMarkdown(ctx)], { type: 'text/markdown;charset=utf-8' });
    Docx.download(blob, baseName(ctx) + '.md');
  });

  els.copy.addEventListener('click', function () {
    if (!state || !state.chapters.length) return;
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
