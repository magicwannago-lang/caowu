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
})();
