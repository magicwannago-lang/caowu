/* ============================================================
   草屋 · 交互
   克制优先：眉滚动、缓入、导航高亮、侧边栏浮出。
   听音单独在 ambient.js / dock.js，此处只管页面本身。
   无框架、无依赖。动效服务留白，不抢内容。
   ============================================================ */

(function () {
  'use strict';

  document.documentElement.classList.remove('no-js');

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 1. 滚动时页眉递出细线 ---------- */
  var header = document.querySelector('.site-header');
  if (header) {
    var onScrollHeader = function () {
      header.classList.toggle('is-scrolled', window.scrollY > 12);
    };
    onScrollHeader();
    window.addEventListener('scroll', onScrollHeader, { passive: true });
  }

  /* ---------- 2. 缓慢浮起入场，每块只做一次 ----------
     同一批（视口内同时出现）错开 110ms，形成次第感；
     不同分区各自计数，长页面往下滚时不会积成一大串。 */
  var revealables = Array.prototype.slice.call(document.querySelectorAll('.reveal'));

  if (!reduceMotion && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      var batch = entries.filter(function (e) { return e.isIntersecting; });

      batch.forEach(function (entry, i) {
        entry.target.style.setProperty('--reveal-delay', Math.min(i, 5) * 110 + 'ms');
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      });

      // 同一批里靠下的稍晚一点，像书页自上而下显影
      batch.sort(function (a, b) {
        return a.target.getBoundingClientRect().top - b.target.getBoundingClientRect().top;
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

    revealables.forEach(function (el) { io.observe(el); });
  } else {
    revealables.forEach(function (el) { el.classList.add('is-in'); });
  }

  /* ---------- 3. 导航高亮：当前所在分区 ---------- */
  var navLinks = Array.prototype.slice.call(document.querySelectorAll('.nav a[href^="#"]'));
  var sections = navLinks
    .map(function (a) { return document.querySelector(a.getAttribute('href')); })
    .filter(Boolean);

  if (sections.length && 'IntersectionObserver' in window) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        navLinks.forEach(function (a) {
          var hit = a.getAttribute('href') === '#' + entry.target.id;
          a.classList.toggle('is-active', hit);
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    sections.forEach(function (s) { spy.observe(s); });
  }

  /* ---------- 4. 卷首滑过去，浅一层，让位给内容 ---------- */
  var hero = document.querySelector('.hero');
  var headerH = 0;

  function measure() {
    headerH = header ? header.offsetHeight : 0;
  }
  measure();
  window.addEventListener('resize', measure, { passive: true });

  if (hero && 'IntersectionObserver' in window) {
    var heroWatch = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        document.body.classList.toggle('past-hero', !e.isIntersecting && e.boundingClientRect.top < 0);
      });
    }, { threshold: 0 });
    heroWatch.observe(hero);
  }

  /* ---------- 5. 氛围层：滚深了退一点，不压内容 ---------- */
  var atmos = document.querySelector('.atmos');
  if (atmos) {
    var ticking = false;
    var onScrollAtmos = function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        atmos.classList.toggle('is-deep', window.scrollY > window.innerHeight * 0.9);
        ticking = false;
      });
    };
    onScrollAtmos();
    window.addEventListener('scroll', onScrollAtmos, { passive: true });
  }

  /* ---------- 6. 衡几 · 内部工具默认收起 ---------- */
  document.querySelectorAll('[data-collapse]').forEach(function (btn) {
    var target = document.getElementById(btn.getAttribute('data-collapse'));
    if (!target) return;

    btn.addEventListener('click', function () {
      var open = target.hasAttribute('hidden') === false;
      if (open) {
        target.setAttribute('hidden', '');
      } else {
        target.removeAttribute('hidden');
      }
      btn.textContent = open ? '展开' : '收起';
      btn.setAttribute('aria-expanded', String(!open));
    });
  });

  /* ---------- 7. 衡几 · 两件器物 ----------
     逻辑在 hengji.js（决策本地问法；文案请 Worker 先生出稿，失败退骨架），此处只做接线。

     对话状态存在闭包里，**不写 localStorage**——这一类自省的话
     不该留在机器上，关掉页面即散，与 hengji.js 的说法一致。 */
  var hengji = window.Hengji;

  if (hengji) {

    /* 文案起草：请衡几先生（Worker）出稿；先生不在就退回本地骨架 */
    (function () {
      var box = document.querySelector('[data-tool-box="copy"]');
      if (!box) return;

      var input = box.querySelector('textarea');
      var output = box.querySelector('.output');
      var meta = box.querySelector('.output-meta');
      var runBtn = box.querySelector('[data-tool="copy"]');

      if (!input || !output || !runBtn) return;

      runBtn.addEventListener('click', function () {
        var text = input.value.trim();
        if (!text) {
          output.textContent = '先写下题目或心里的那件事。一句话就够。';
          output.removeAttribute('hidden');
          if (meta) meta.setAttribute('hidden', '');
          input.focus();
          return;
        }

        runBtn.disabled = true;
        runBtn.textContent = '先生正在想…';
        output.textContent = '';
        output.removeAttribute('hidden');
        if (meta) { meta.textContent = ''; meta.setAttribute('hidden', ''); }

        hengji.generate(text).then(function (r) {
          output.textContent = r.copy;
          renderSources(meta, r.sources);
          runBtn.textContent = '再请先生写一副';
        }).catch(function () {
          output.textContent = '先生今日不在，先给你一副骨架。\n\n' + hengji.draft(text);
          runBtn.textContent = '再请先生写一副';
        }).then(function () {
          runBtn.disabled = false;
        });
      });

      // 时事来源以淡墨小字另列一行，不混进文案
      function renderSources(el, sources) {
        if (!el) return;
        var news = (sources && sources.news) || [];
        if (!news.length) { el.setAttribute('hidden', ''); return; }

        el.textContent = '';
        var label = document.createElement('span');
        label.className = 'output-meta-label';
        label.textContent = '时事出处';
        el.appendChild(label);

        news.forEach(function (n) {
          var a = document.createElement('a');
          a.href = n.url || '#';
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = n.title || n.url;
          el.appendChild(a);
        });
        el.removeAttribute('hidden');
      }
    })();

    /* 决策问答：多轮，一步一步来 */
    (function () {
      var box = document.querySelector('[data-tool-box="decide"]');
      if (!box) return;

      var input = box.querySelector('textarea');
      var output = box.querySelector('.output');
      var note = box.querySelector('[data-tool-note="decide"]');
      var runBtn = box.querySelector('[data-tool="decide"]');
      var resetBtn = box.querySelector('[data-tool-reset="decide"]');

      if (!input || !output || !runBtn) return;

      var STEP_COUNT = 5;
      // 「开始追问」与「下一句」共用一个按钮，改文案让意图显出来
      var IDLE_LABEL = runBtn.textContent;
      var REST_LABEL = '下一句';
      // 题面、答复框都是同一个 textarea，靠 state 区分当前该读哪个
      var state = null;

      function rest() {
        input.placeholder = input.getAttribute('data-answer-placeholder') || '写下你的回答，写完点「下一句」';
        input.classList.add('is-answer');
      }

      // 换上这一问的话；因是 aria-live，读屏会跟着播报
      function say(text) {
        output.textContent = text;
        output.removeAttribute('hidden');
        output.scrollTop = output.scrollHeight;
      }

      function reset() {
        state = null;
        input.value = '';
        input.classList.remove('is-answer');
        input.placeholder = input.getAttribute('data-brief-placeholder') || '';
        output.textContent = '';
        output.setAttribute('hidden', '');
        runBtn.textContent = IDLE_LABEL;
        if (resetBtn) resetBtn.setAttribute('hidden', '');
        if (note) note.textContent = note.getAttribute('data-base') || '';
      }

      runBtn.addEventListener('click', function () {
        var text = input.value.trim();

        if (!state) {
          if (!text) {
            say('先把事写下来。一句话就够——写不出，多半还没到要问的时候。');
            input.focus();
            return;
          }
          var first = hengji.step(null, text);
          state = first.state;
          say(first.text);
          rest();
          runBtn.textContent = REST_LABEL;
          if (note) note.textContent = '第一问 · 共五问';
          input.value = '';
          input.focus();
          return;
        }

        // 刚问完这一句、答复框还空着就点：当作误触，不推进，只把光标送回去
        if (!text) {
          input.focus();
          return;
        }

        var r = hengji.step(state, text);
        state = r.state;
        say(r.text);
        input.value = '';

        if (r.done) {
          runBtn.textContent = '再问一件';
          if (resetBtn) resetBtn.removeAttribute('hidden');
          // 提前收尾与走满五问，是两件事，别都说成「问完了」
          if (note) {
            note.textContent = state.index >= STEP_COUNT
              ? '五问已尽，答案在你手里'
              : '问到第 ' + state.index + ' 问，到此为止';
          }
          input.classList.remove('is-answer');
        } else {
          if (note) {
            note.textContent = '第 ' + Math.min(state.index + 1, STEP_COUNT) +
                               ' 问 · 共 ' + STEP_COUNT + ' 问';
          }
          input.focus();
        }
      });

      if (resetBtn) {
        resetBtn.addEventListener('click', function () {
          reset();
          input.focus();
        });
      }

      // 收起时的初值：题面占位与底部那句话，重来时照原样还回去
      input.setAttribute('data-brief-placeholder', input.placeholder);
      if (note) note.setAttribute('data-base', note.textContent);
    })();
  }
})();
