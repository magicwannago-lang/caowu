/* ============================================================
   草屋 · 雨丝
   一层 canvas 上的斜雨。密而轻，落而不响，水痕在檐下散开。

   克制之处：
   - 粒子数按屏宽给上限（省电）
   - 30fps 上限；页面隐藏或滚过时停笔
   - prefers-reduced-motion 时整个画布不出现
   - 风只吹一点点：雨是斜的，不是泼的
   ============================================================ */

(function () {
  'use strict';

  var canvas = document.getElementById('rain-canvas');
  if (!canvas || !canvas.getContext) return;

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (reduce.matches) return;

  var g = canvas.getContext('2d');
  var W = 0, H = 0, dpr = 1;
  var drops = [];
  var rings = [];
  var raf = 0;
  var last = 0;
  var visible = true;
  var FRAME = 1000 / 30;          // 30fps 上限

  var COLOR = '138, 163, 161';    // --rain，拆成 rgb 供透明度使用

  function rnd(a, b) { return a + Math.random() * (b - a); }

  function makeDrop(spawnAnywhere) {
    // 远近两档：远者细慢，近者稍快稍长
    var near = Math.random() < 0.34;
    var speed = near ? rnd(340, 520) : rnd(180, 300);
    var len = near ? rnd(26, 52) : rnd(14, 32);

    return {
      x: rnd(-0.15, 1.15) * W,
      y: spawnAnywhere ? rnd(0, H) : rnd(-120, -10),
      v: speed,
      len: len,
      w: near ? 1.15 : 0.75,
      a: near ? rnd(0.16, 0.3) : rnd(0.07, 0.16)
    };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth || window.innerWidth;
    H = canvas.clientHeight || window.innerHeight;

    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 粒子数：屏宽定档，上限 78 条，再多就吵了
    var target = W < 640 ? 26 : W < 1024 ? 46 : 78;
    drops.length = 0;
    for (var i = 0; i < target; i++) drops.push(makeDrop(true));

    rings.length = 0;
    var ringCount = W < 640 ? 2 : 3;
    for (var j = 0; j < ringCount; j++) rings.push(makeRing(true));
  }

  /* 檐下的一圈涟漪：极慢、极淡、只有两三枚 */
  function makeRing(spawnAnywhere) {
    return {
      x: rnd(0.08, 0.92) * W,
      y: rnd(0.55, 0.92) * H,
      r: rnd(2, 6),
      max: rnd(26, 58),
      a: rnd(0.05, 0.11),
      life: spawnAnywhere ? rnd(0, 1) : 0,
      dur: rnd(6, 11)
    };
  }

  function drawDrop(d) {
    // 斜角固定，风是稳定的：雨才会成丝而不是碎点
    var slant = 0.22;
    g.strokeStyle = 'rgba(' + COLOR + ', ' + d.a + ')';
    g.lineWidth = d.w;
    g.beginPath();
    g.moveTo(d.x, d.y);
    g.lineTo(d.x + d.len * slant, d.y + d.len);
    g.stroke();
  }

  function drawRing(r) {
    // 用极扁的椭圆，像水面上的圈，不像靶心
    var ease = 1 - Math.pow(1 - r.life, 2);
    var rad = r.r + (r.max - r.r) * ease;
    var fade = Math.sin(Math.PI * r.life);
    g.strokeStyle = 'rgba(' + COLOR + ', ' + (r.a * fade) + ')';
    g.lineWidth = 0.7;
    g.beginPath();
    g.ellipse(r.x, r.y, rad, rad * 0.28, 0, 0, Math.PI * 2);
    g.stroke();
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!visible) return;
    if (now - last < FRAME) return;

    var dt = Math.min((now - last) / 1000, 0.1);
    last = now;

    g.clearRect(0, 0, W, H);

    for (var i = 0; i < drops.length; i++) {
      var d = drops[i];
      d.y += d.v * dt;
      d.x += d.v * 0.22 * dt;
      if (d.y > H + 40 || d.x > W + 60) drops[i] = makeDrop(false);
      drawDrop(d);
    }

    for (var j = 0; j < rings.length; j++) {
      var r = rings[j];
      r.life += dt / r.dur;
      if (r.life >= 1) { rings[j] = makeRing(false); }
      else drawRing(r);
    }
  }

  function start() {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  resize();
  start();

  var resizeTimer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      resize();
      g.clearRect(0, 0, W, H);
    }, 180);
  }, { passive: true });

  // 切走标签页：停笔
  document.addEventListener('visibilitychange', function () {
    visible = !document.hidden;
    if (visible) { last = performance.now(); }
  });

  // 系统动效偏好中途改变
  if (reduce.addEventListener) {
    reduce.addEventListener('change', function (e) {
      if (e.matches) { stop(); canvas.style.display = 'none'; }
      else { canvas.style.display = ''; resize(); start(); }
    });
  }
})();
