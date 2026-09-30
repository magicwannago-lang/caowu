/* MOON 启动接线：立意——根据经验（remember times）做辅助决策。
   负责：载入经验库（skills/memories 两个计数）、欢迎播报（syber_first.mp3，
   只闻其声不设状态条）、session uptime 走字与其下方进度条 8 秒流动、
   网络状态、启动日志。背景粒子装置在 brain-rig.js。 */
(function () {
  'use strict';

  var BOOT_MS = 8000;                 // 引导时长，与 syber_first.mp3（约 8 秒）等长
  var wallStart = Date.now();

  /* 全局声音状态：禁声总闸（欢迎播报＋回复 TTS），brain-chat.js 订阅 */
  var MOON = window.MOON = window.MOON || {};
  MOON.muted = !!MOON.muted;
  MOON._muteListeners = MOON._muteListeners || [];
  MOON.onMute = function (fn) { MOON._muteListeners.push(fn); fn(MOON.muted); };
  MOON.setMuted = function (m) {
    m = !!m;
    if (m === MOON.muted) return;
    MOON.muted = m;
    MOON._muteListeners.forEach(function (fn) { fn(m); });
  };

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

  /* ---------------- uptime 下方进度条：亮区 8 秒流动着充满 ----------------
     细槽样式不动；宽度 0→100%，充满即加载与播报完成，完成后保持满条。 */
  var fill = document.querySelector('.progress-fill');
  var bootStart = performance.now();
  function ease(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function flowFrame(now) {
    var p = Math.max(0, Math.min(1, (now - bootStart) / BOOT_MS));
    fill.style.width = (ease(p) * 100) + '%';
    if (p < 1) requestAnimationFrame(flowFrame);
  }
  if (reduceMotion) {
    fill.style.width = '100%';
  } else {
    requestAnimationFrame(flowFrame);
  }

  /* ---------------- 欢迎播报：进页面即播；被拦则首次手势补播 ----------------
     一旦真正开始播放（playing）立即移除手势监听——否则播报结束后
     点击页面会再播一遍（已修）。 */
  function tryPlay() {
    if (MOON.muted) return;            // 已禁声：不起播报
    audio.play().catch(function () {});
  }
  function gesturePlay() { disarmGesture(); tryPlay(); }
  function disarmGesture() {
    document.removeEventListener('pointerdown', gesturePlay);
    document.removeEventListener('keydown', gesturePlay);
  }
  audio.addEventListener('playing', disarmGesture);
  tryPlay();
  document.addEventListener('pointerdown', gesturePlay);
  document.addEventListener('keydown', gesturePlay);

  /* ---------------- 禁声总闸：TRANSCRIPT 旁按钮 ---------------- */
  var muteBtn = document.getElementById('mute-btn');
  muteBtn.addEventListener('click', function () { MOON.setMuted(!MOON.muted); });
  MOON.onMute(function (m) {
    muteBtn.textContent = m ? '已禁声' : '禁声';
    muteBtn.classList.toggle('is-muted', m);
    muteBtn.setAttribute('aria-pressed', String(m));
    if (m) audio.pause();              // TTS 由 brain-chat.js 的订阅取消
  });

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
