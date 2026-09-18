/* ============================================================
   草屋 · 侧边栏与听音
   把 ambient.js 的那一路声音接到界面：侧栏那枚按钮，以及观隅的播放器。

   浮出规则：滚过卷首（hero）才出现，回到顶端即沉回屏外。
   理由：卷首是一整页留白，不该被控件打扰。
   ============================================================ */

(function () {
  'use strict';

  var dock = document.getElementById('dock');
  var toggle = document.getElementById('ambient-toggle');
  var vol = document.getElementById('ambient-vol');
  var dockProgress = document.getElementById('dock-progress');
  var dockSub = document.getElementById('dock-sub');

  var playerToggle = document.querySelector('[data-ambient-toggle]');
  var playerProgress = document.querySelector('[data-ambient-progress]');
  var playerSub = document.querySelector('[data-ambient-sub]');
  var glyph = playerToggle ? playerToggle.querySelector('.glyph') : null;

  /* ---------- 1. 浮出：滚过卷首 ---------- */

  if (dock) {
    var hero = document.querySelector('.hero');
    var threshold = hero ? hero.offsetHeight * 0.55 : window.innerHeight * 0.5;

    var updateDock = function () {
      dock.classList.toggle('is-out', window.scrollY > threshold);
    };

    window.addEventListener('resize', function () {
      threshold = hero ? hero.offsetHeight * 0.55 : window.innerHeight * 0.5;
      updateDock();
    }, { passive: true });

    var tick = false;
    window.addEventListener('scroll', function () {
      if (tick) return;
      tick = true;
      requestAnimationFrame(function () {
        updateDock();
        tick = false;
      });
    }, { passive: true });

    updateDock();
  }

  /* ---------- 2. 把声音状态画到界面 ---------- */

  var progressTimer = 0;

  function startProgress() {
    var bars = [dockProgress, playerProgress].filter(Boolean);
    if (!bars.length || Ambient.hasFile()) return;

    // 合成的声音没有时长，进度条只作「水在流」的示意：
    // 一条极缓的横移，不做百分比，不假装有终点。
    var t0 = performance.now();
    var step = function (now) {
      var p = ((now - t0) / 1000 % 14) / 14;          // 14 秒一轮
      var eased = p < 0.5 ? p * 2 : (1 - p) * 2;      // 来回往复
      var w = (12 + eased * 62).toFixed(2) + '%';
      bars.forEach(function (b) { b.style.width = w; });
      progressTimer = requestAnimationFrame(step);
    };
    progressTimer = requestAnimationFrame(step);
  }

  function stopProgress() {
    if (progressTimer) cancelAnimationFrame(progressTimer);
    progressTimer = 0;
    [dockProgress, playerProgress].forEach(function (b) {
      if (b) b.style.width = '0%';
    });
  }

  function paint(state) {
    var on = state.playing;

    if (toggle) {
      toggle.classList.toggle('is-playing', on);
      toggle.setAttribute('aria-pressed', String(on));
      toggle.setAttribute('aria-label', on ? '暂停雨声与流水' : '播放雨声与流水');
    }

    if (playerToggle) {
      playerToggle.classList.toggle('is-playing', on);
      playerToggle.setAttribute('aria-pressed', String(on));
      playerToggle.setAttribute('aria-label', on ? '暂停雨声与流水' : '播放雨声与流水');
    }
    if (glyph) glyph.textContent = on ? '停' : '听';

    if (playerSub) {
      playerSub.textContent = on
        ? '雨丝与檐下流水，正在响'
        : (Ambient.hasFile() ? '雨落草檐，缓缓循环' : '雨丝与檐下流水，缓慢循环');
    }
    if (dockSub) {
      dockSub.textContent = on ? '正在响 · 缓缓循环' : '雨丝与檐下流水，缓慢循环';
    }
    if (vol && document.activeElement !== vol) {
      vol.value = String(Math.round(state.volume * 100));
    }

    if (on) startProgress(); else stopProgress();
  }

  if (window.Ambient) {
    Ambient.onChange(paint);
    Ambient.init();
  }

  /* ---------- 3. 点击：两处按钮同一路声音 ---------- */

  function clickToggle(e) {
    e.preventDefault();
    if (window.Ambient) Ambient.toggle();
  }

  if (toggle) toggle.addEventListener('click', clickToggle);
  if (playerToggle) playerToggle.addEventListener('click', clickToggle);

  /* ---------- 4. 音量 ---------- */

  if (vol) {
    vol.addEventListener('input', function () {
      if (window.Ambient) Ambient.setVolume(parseInt(vol.value, 10) / 100);
    });
  }

  /* ---------- 5. 键盘可达：Tab 到侧栏即展开小卡 ---------- */

  if (dock) {
    dock.addEventListener('focusin', function () { dock.classList.add('is-open'); });
    dock.addEventListener('focusout', function (e) {
      if (!dock.contains(e.relatedTarget)) dock.classList.remove('is-open');
    });
    dock.addEventListener('mouseleave', function () { dock.classList.remove('is-open'); });

    // 触屏：轻点曲目名展开小卡
    var label = dock.querySelector('.dock-label');
    if (label) {
      label.addEventListener('click', function () {
        dock.classList.toggle('is-open');
      });
    }
  }
})();
