/* MOON 启动接线：欢迎播报（syber_first.mp3，只闻其声不设状态条）、
   session uptime 走字、网络状态、启动日志。背景粒子装置在 brain-rig.js。 */
(function () {
  'use strict';

  var wallStart = Date.now();

  var audio = document.getElementById('welcome-audio');
  var uptimeEl = document.getElementById('stat-uptime');
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

  /* ---------------- 欢迎播报：进页面即播；被拦则首次点击/按键时补播 ---------------- */
  function tryPlay() { audio.play().catch(function () {}); }
  tryPlay();
  document.addEventListener('pointerdown', tryPlay, { once: true });
  document.addEventListener('keydown', tryPlay, { once: true });

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
  }, 8000);
})();
