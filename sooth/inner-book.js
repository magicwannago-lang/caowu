/* ============================================================
   七彩屋 · 内养书卷
   点「试读」进入全屏阅读：左列章节目标标题（着重当前、可收缩、
   点击跳章），右列正文；字体可选、字号可调。
   书卷数据在 assets/inner-book.json（与主站共用一份），
   读取失败时退内置示例三篇——七彩屋不假装有内容。
   ============================================================ */

(function () {
  'use strict';

  /* sooth 页在站点二级目录，数据要回身上一级取 */
  var DATA_URL = '../assets/inner-book.json';
  var PREF_KEY = 'sevencolor.reader.prefs';

  var reader = document.getElementById('reader');
  var openers = document.querySelectorAll('[data-trial-open]');
  if (!reader || !openers.length) return;

  /* 字体四式：值是字体栈，直接落到阅读正文上 */
  var FONTS = [
    { key: 'song', label: '宋体',
      stack: "'Noto Serif SC','Source Han Serif SC','Songti SC','SimSun',serif" },
    { key: 'fang', label: '仿宋',
      stack: "'Noto Serif SC','FangSong','STFangsong','仿宋',serif" },
    { key: 'kai', label: '楷体',
      stack: "'Kaiti SC','STKaiti','KaiTi','楷体','Noto Serif SC','Songti SC',serif" },
    { key: 'hei', label: '黑体',
      stack: "'Noto Sans SC','Source Han Sans SC','Noto Sans CJK SC','PingFang SC','Microsoft YaHei',sans-serif" }
  ];

  /* 字号五档（px） */
  var SIZES = [15, 17, 19, 22, 26];

  var DEMO = {
    book: {
      name: '养静小集（示例）',
      intro: '清单未读到，先陈示例三篇。替换 assets/inner-book.json 即可。'
    },
    chapters: [
      { id: 'd1', title: '陋室铭 · 刘禹锡',
        paragraphs: ['山不在高，有仙则名。水不在深，有龙则灵。斯是陋室，惟吾德馨。',
          '苔痕上阶绿，草色入帘青。谈笑有鸿儒，往来无白丁。孔子云：何陋之有？'] },
      { id: 'd2', title: '爱莲说 · 周敦颐',
        paragraphs: ['予独爱莲之出淤泥而不染，濯清涟而不妖，中通外直，不蔓不枝，香远益清，亭亭净植，可远观而不可亵玩焉。',
          '莲，花之君子者也。'] },
      { id: 'd3', title: '诫子书 · 诸葛亮',
        paragraphs: ['静以修身，俭以养德。非淡泊无以明志，非宁静无以致远。',
          '夫学须静也，才须学也。非学无以广才，非志无以成学。'] }
    ]
  };

  var book = null;
  var chapters = [];
  var prefs = readPrefs();

  /* ---------- DOM ---------- */

  var tocList = reader.querySelector('#reader-toc-list');
  var scrollEl = reader.querySelector('#reader-scroll');
  var bodyEl = reader.querySelector('#reader-body');
  var bookNameEl = reader.querySelector('#reader-book-name');
  var closeBtn = reader.querySelector('#reader-close');
  var tocBtn = reader.querySelector('#reader-toc-btn');
  var tocCloseBtn = reader.querySelector('#reader-toc-close');
  var fontGroup = reader.querySelector('.reader-fonts');
  var sizeInc = reader.querySelector('[data-size-inc]');
  var sizeDec = reader.querySelector('[data-size-dec]');
  var sizeNum = reader.querySelector('[data-size-num]');

  function readPrefs() {
    var p = { font: 'song', size: 2, tocCollapsed: false };
    try {
      var raw = JSON.parse(localStorage.getItem(PREF_KEY));
      if (raw) {
        if (FONTS.some(function (f) { return f.key === raw.font; })) p.font = raw.font;
        if (typeof raw.size === 'number' && raw.size >= 0 && raw.size < SIZES.length) p.size = raw.size;
        p.tocCollapsed = !!raw.tocCollapsed;
      }
    } catch (e) { /* 忽略 */ }
    return p;
  }

  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* 忽略 */ }
  }

  /* ---------- 渲染阅读器 ---------- */

  function renderReader() {
    if (bookNameEl) bookNameEl.textContent = book.name;
    if (tocList) tocList.textContent = '';
    if (bodyEl) bodyEl.textContent = '';

    chapters.forEach(function (ch) {
      /* 左：目录一项 */
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'reader-toc-item';
      b.textContent = ch.title;
      b.addEventListener('click', function () { jumpToChapter(b); });
      li.appendChild(b);
      tocList.appendChild(li);

      /* 右：一章 */
      var sec = document.createElement('section');
      sec.className = 'reader-chapter';
      sec.id = 'reader-ch-' + ch.id;
      var h = document.createElement('h3');
      h.className = 'reader-chapter-title';
      h.textContent = ch.title;
      sec.appendChild(h);
      ch.paragraphs.forEach(function (p) {
        var para = document.createElement('p');
        para.className = 'reader-p';
        para.textContent = p;
        sec.appendChild(para);
      });
      bodyEl.appendChild(sec);
    });

    applyFont();
    applySize();
  }

  /* ---------- 字体 / 字号 ---------- */

  function renderFontButtons() {
    if (!fontGroup) return;
    fontGroup.textContent = '';
    FONTS.forEach(function (f) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'reader-chip' + (f.key === prefs.font ? ' is-current' : '');
      b.textContent = f.label;
      b.setAttribute('aria-pressed', String(f.key === prefs.font));
      b.addEventListener('click', function () {
        prefs.font = f.key;
        applyFont();
        fontGroup.querySelectorAll('.reader-chip').forEach(function (el, i) {
          var on = FONTS[i].key === prefs.font;
          el.classList.toggle('is-current', on);
          el.setAttribute('aria-pressed', String(on));
        });
        savePrefs();
      });
      fontGroup.appendChild(b);
    });
  }

  function applyFont() {
    var f = FONTS.filter(function (x) { return x.key === prefs.font; })[0] || FONTS[0];
    if (bodyEl) bodyEl.style.fontFamily = f.stack;
  }

  function applySize() {
    if (bodyEl) bodyEl.style.fontSize = SIZES[prefs.size] + 'px';
    if (sizeNum) sizeNum.textContent = SIZES[prefs.size] + 'px';
    if (sizeDec) sizeDec.disabled = prefs.size <= 0;
    if (sizeInc) sizeInc.disabled = prefs.size >= SIZES.length - 1;
  }

  function changeSize(d) {
    var next = Math.min(SIZES.length - 1, Math.max(0, prefs.size + d));
    if (next === prefs.size) return;
    prefs.size = next;
    applySize();
    savePrefs();
  }

  if (sizeInc) sizeInc.addEventListener('click', function () { changeSize(1); });
  if (sizeDec) sizeDec.addEventListener('click', function () { changeSize(-1); });

  /* ---------- 目录：跳章 / 着重 / 收缩 ---------- */

  function jumpToChapter(btn) {
    var i = Array.prototype.indexOf.call(tocList.querySelectorAll('.reader-toc-item'), btn);
    var sec = bodyEl.children[i];
    if (!sec) return;
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    sec.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    if (window.matchMedia('(max-width: 640px)').matches) reader.classList.remove('is-toc-open');
  }

  function setActive(i) {
    if (!tocList) return;
    tocList.querySelectorAll('.reader-toc-item').forEach(function (b, j) {
      var on = j === i;
      b.classList.toggle('is-current', on);
      if (on) b.setAttribute('aria-current', 'true');
      else b.removeAttribute('aria-current');
    });
    // 让当前标题留在目录的可视处，不与阅读抢焦点
    var cur = tocList.children[i];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function setTocCollapsed(collapsed) {
    reader.classList.toggle('is-toc-collapsed', collapsed);
    prefs.tocCollapsed = collapsed;
    if (tocBtn) tocBtn.setAttribute('aria-pressed', String(!collapsed));
    savePrefs();
  }

  if (tocBtn) tocBtn.addEventListener('click', function () {
    // 窄屏目录是抽屉：开/合；宽屏是栅格：收/放
    if (window.matchMedia('(max-width: 640px)').matches) {
      reader.classList.toggle('is-toc-open');
    } else {
      setTocCollapsed(!reader.classList.contains('is-toc-collapsed'));
    }
  });
  if (tocCloseBtn) tocCloseBtn.addEventListener('click', function () {
    if (window.matchMedia('(max-width: 640px)').matches) reader.classList.remove('is-toc-open');
    else setTocCollapsed(true);
  });

  /* 阅读位置监听：正文滚到哪一章，目录着重哪一章 */
  var spy = null;
  function startSpy() {
    if (!('IntersectionObserver' in window)) return;
    spy = new IntersectionObserver(function (entries) {
      var best = null;
      entries.forEach(function (e) {
        if (e.isIntersecting && (!best || e.intersectionRatio > best.intersectionRatio)) best = e;
      });
      if (best) {
        var idx = Array.prototype.indexOf.call(bodyEl.children, best.target);
        if (idx >= 0) setActive(idx);
      }
    }, { root: scrollEl, rootMargin: '-15% 0px -70% 0px', threshold: [0, 0.25, 1] });
    Array.prototype.forEach.call(bodyEl.children, function (sec) { spy.observe(sec); });
  }

  /* ---------- 开合全屏 ---------- */

  var lastFocus = null;

  function openReader() {
    if (!chapters.length) return;
    lastFocus = document.activeElement;
    reader.hidden = false;
    // 窄屏默认不展开抽屉；宽屏沿用上回的收/放
    reader.classList.toggle('is-toc-collapsed',
      prefs.tocCollapsed && !window.matchMedia('(max-width: 640px)').matches);
    document.body.style.overflow = 'hidden';
    if (scrollEl) scrollEl.scrollTop = 0;
    setActive(0);
    if (closeBtn) closeBtn.focus();
  }

  function closeReader() {
    reader.hidden = true;
    reader.classList.remove('is-toc-open');
    document.body.style.overflow = '';
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  openers.forEach(function (el) { el.addEventListener('click', openReader); });
  if (closeBtn) closeBtn.addEventListener('click', closeReader);
  document.addEventListener('keydown', function (e) {
    if (reader.hidden) return;
    if (e.key === 'Escape') closeReader();
  });

  /* ---------- 取材：清单 → 内置示例 ---------- */

  function load(data) {
    var ok = data && data.book && data.chapters && data.chapters.length;
    var d = ok ? data : DEMO;
    book = d.book;
    chapters = d.chapters;
    renderReader();
    renderFontButtons();
    if (tocBtn) tocBtn.setAttribute('aria-pressed', String(!prefs.tocCollapsed));
    startSpy();
  }

  fetch(DATA_URL, { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(load)
    .catch(function () { load(null); });

})();
