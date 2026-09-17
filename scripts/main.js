/* ============================================================
   草屋 · 交互
   克制优先：只做三件事——眉滚动、缓入、听音播放。
   无框架、无依赖。动效服务留白，不抢内容。
   ============================================================ */

(function () {
  'use strict';

  document.documentElement.classList.remove('no-js');

  /* ---------- 1. 滚动时页眉递出细线 ---------- */
  var header = document.querySelector('.site-header');
  if (header) {
    var onScrollHeader = function () {
      header.classList.toggle('is-scrolled', window.scrollY > 12);
    };
    onScrollHeader();
    window.addEventListener('scroll', onScrollHeader, { passive: true });
  }

  /* ---------- 2. 缓慢浮起入场，每块只做一次 ---------- */
  var revealables = document.querySelectorAll('.reveal');
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!reduce && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry, i) {
        if (!entry.isIntersecting) return;
        // 同批元素错开 90ms，形成轻微的次第感
        var delay = Math.min(i, 4) * 90;
        setTimeout(function () {
          entry.target.classList.add('is-in');
        }, delay);
        io.unobserve(entry.target);
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

  /* ---------- 4. 观隅 · 听音 ---------- */
  var toggle = document.querySelector('.player-toggle');
  var audio = document.querySelector('.player audio');
  var progress = document.querySelector('.player-progress');

  if (toggle && audio) {
    var icon = toggle.querySelector('.glyph');

    toggle.addEventListener('click', function () {
      if (audio.paused) {
        // 未放入音频文件时不报错，只做安静的示意
        var play = audio.play();
        if (play && typeof play.catch === 'function') {
          play.catch(function () {
            if (icon) icon.textContent = '待';
            toggle.setAttribute('aria-label', '尚未放入音频');
          });
        }
      } else {
        audio.pause();
      }
    });

    audio.addEventListener('play', function () {
      if (icon) icon.textContent = '停';
      toggle.setAttribute('aria-label', '暂停');
    });
    audio.addEventListener('pause', function () {
      if (icon) icon.textContent = '听';
      toggle.setAttribute('aria-label', '播放');
    });
    audio.addEventListener('timeupdate', function () {
      if (!progress || !audio.duration) return;
      progress.style.width = (audio.currentTime / audio.duration) * 100 + '%';
    });
    audio.addEventListener('ended', function () {
      if (progress) progress.style.width = '0%';
    });
  }

  /* ---------- 5. 衡几 · 内部工具默认收起 ---------- */
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
})();
