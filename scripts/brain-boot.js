/* MOON 启动接线：立意——根据经验（remember times）做辅助决策。
   负责：载入经验库（skills/memories 两个计数）、欢迎播报（syber_first.mp3，
   只闻其声不设状态条）、session uptime 走字与其下方进度条 8 秒流动、
   网络状态、启动日志。背景粒子装置在 brain-rig.js。 */
(function () {
  'use strict';

  var BOOT_MS = 8000;                 // 引导时长，与 syber_first.mp3（约 8 秒）等长
  var wallStart = Date.now();

  var reduceMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var audio = document.getElementById('welcome-audio');
  var uptimeEl = document.getElementById('stat-uptime');
  var skillsEl = document.getElementById('stat-skills');
  var rememberEl = document.getElementById('stat-remember');
  var networkEl = document.getElementById('stat-network');
  var logEl = document.getElementById('sys-log');
  var centerStatus = document.getElementById('center-status');

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clock() {
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function fmtUptime(ms) {
    var s = Math.floor(ms / 1000);
    return pad(Math.floor(s / 60)) + ':' + pad(s % 60);
  }
  function log(text) {
    var p = document.createElement('p');
    p.className = 'log-line';
    p.textContent = '[' + clock() + '] ' + text;
    logEl.appendChild(p);
    logEl.scrollTop = logEl.scrollHeight;
  }

  /* ---------------- session uptime：每秒走字 ---------------- */
  uptimeEl.textContent = '00:00';
  setInterval(function () {
    uptimeEl.textContent = fmtUptime(Date.now() - wallStart);
  }, 1000);

  /* ---------------- 经验库：skills number / remember times ---------------- */
  fetch('assets/brain/memories.json', { cache: 'no-cache' })
    .then(function (r) { return r.json(); })
    .then(function (store) {
      skillsEl.textContent = (store.skills || []).length;
      rememberEl.textContent = (store.memories || []).length;
      log('memory recall: ' + (store.memories || []).length
        + ' experiences, ' + (store.skills || []).length + ' skills.');
    })
    .catch(function () {
      skillsEl.textContent = '0';
      rememberEl.textContent = '0';
    });

  /* ---------------- uptime 下方进度条：亮段 8 秒自左向右流动一次 ----------------
     样式不动（仍为细槽内的亮段），只改位置；流尽沉静收淡。 */
  var fill = document.querySelector('.progress-fill');
  var bootStart = performance.now();
  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function flowFrame(now) {
    var p = Math.max(0, Math.min(1, (now - bootStart) / BOOT_MS));
    var x = -0.4 + ease(p) * 1.4;   // left: -40% → 100%
    fill.style.left = (x * 100) + '%';
    if (p < 1) requestAnimationFrame(flowFrame);
    else {
      fill.style.transition = 'opacity 0.8s ease';
      fill.style.opacity = '0.35';  // 引导完成，沉静收淡
    }
  }
  if (reduceMotion) {
    fill.style.left = '100%';
    fill.style.opacity = '0.35';
  } else {
    requestAnimationFrame(flowFrame);
  }

  /* ---------------- 欢迎播报：进页面即播；被拦则首次点击/按键时补播 ---------------- */
  function tryPlay() { audio.play().catch(function () {}); }
  tryPlay();
  document.addEventListener('pointerdown', tryPlay, { once: true });
  document.addEventListener('keydown', tryPlay, { once: true });

  /* ---------------- CONTROL 多行输入：随内容增高，到上限后内部滚动（滑轨已隐藏） ---------------- */
  var textInput = document.getElementById('text-input');
  function autosize() {
    textInput.style.height = 'auto';
    textInput.style.height = Math.min(textInput.scrollHeight, 260) + 'px';
  }
  textInput.addEventListener('input', autosize);

  /* ---------------- 网络状态（LINK 栏） ---------------- */
  function syncNetwork() {
    networkEl.textContent = navigator.onLine ? 'ONLINE' : 'OFFLINE';
  }
  syncNetwork();
  window.addEventListener('online', syncNetwork);
  window.addEventListener('offline', syncNetwork);

  /* ---------------- 启动日志 + 中心状态 ---------------- */
  centerStatus.textContent = 'BOOTING…';
  log('MOON interface booting.');
  setTimeout(function () { log('welcome broadcast: syber_first.'); }, 600);
  setTimeout(function () {
    centerStatus.textContent = 'ONLINE AND ACTIVE';
    log('MOON online and active.');
  }, BOOT_MS);
})();
