/* MOON 启动接线：欢迎播报（syber_first.mp3）、session uptime 走字、
   网络状态、启动日志。背景粒子装置在 brain-rig.js，本文件只管 HUD 数据。 */
(function () {
  'use strict';

  var BOOT_MS = 8000;                 // 引导时长与 syber_first.mp3（约 8 秒）等长
  var bootStart = performance.now();
  var wallStart = Date.now();

  var reduceMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var audio = document.getElementById('welcome-audio');
  var bcFill = document.getElementById('broadcast-fill');
  var bcState = document.getElementById('broadcast-state');
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

  /* ---------------- 欢迎播报 ---------------- */
  function setBroadcast(p) {
    bcFill.style.width = (Math.max(0, Math.min(1, p)) * 100) + '%';
  }
  function armFallback() {
    // 自动播放被浏览器拦截：首次点击 / 按键时补播
    bcState.textContent = 'TAP TO PLAY';
    function once() {
      bcState.textContent = 'PLAYING';
      audio.play().catch(function () {});
      document.removeEventListener('pointerdown', once);
      document.removeEventListener('keydown', once);
    }
    document.addEventListener('pointerdown', once);
    document.addEventListener('keydown', once);
  }
  audio.addEventListener('playing', function () { bcState.textContent = 'PLAYING'; });
  audio.addEventListener('timeupdate', function () {
    if (audio.duration) setBroadcast(audio.currentTime / audio.duration);
  });
  audio.addEventListener('ended', function () {
    setBroadcast(1);
    bcState.textContent = 'DONE';
  });
  audio.addEventListener('error', function () { bcState.textContent = 'NONE'; });

  var playP = audio.play();
  if (playP && playP.catch) {
    playP.then(function () { bcState.textContent = 'PLAYING'; }).catch(armFallback);
  }

  /* ---------------- 网络状态（LINK 栏） ---------------- */
  function syncNetwork() {
    networkEl.textContent = navigator.onLine ? 'ONLINE' : 'OFFLINE';
  }
  syncNetwork();
  window.addEventListener('online', syncNetwork);
  window.addEventListener('offline', syncNetwork);

  /* ---------------- uptime 引导轨：8 秒爬到栏目顶部 ---------------- */
  var rail = document.getElementById('uptime-rail');
  var railFill = document.getElementById('rail-fill');
  function railFrame(now) {
    var p = Math.max(0, Math.min(1, (now - bootStart) / BOOT_MS));
    railFill.style.transform = 'scaleY(' + p.toFixed(3) + ')';
    if (p < 1) requestAnimationFrame(railFrame);
    else rail.classList.add('is-done');
  }
  if (reduceMotion) {
    railFill.style.transform = 'scaleY(1)';
    rail.classList.add('is-done');
  } else {
    requestAnimationFrame(railFrame);
  }

  /* ---------------- 引导日志 + 中心状态 ---------------- */
  centerStatus.textContent = 'BOOTING…';
  log('MOON interface booting.');
  setTimeout(function () { log('welcome broadcast: syber_first.'); }, 600);
  setTimeout(function () {
    centerStatus.textContent = 'ONLINE AND ACTIVE';
    log('MOON online and active.');
  }, BOOT_MS);
})();
