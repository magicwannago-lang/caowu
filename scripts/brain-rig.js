/* MOON 背景装置：环绕粒子 + 全息太极阴阳鱼圆盘
   移植自 IB/moon_yinyang.html，改动：
   - 粒子数量按屏面计算并封顶（样板 200 粒子 + O(n²) 连线偏重）；
   - 圆盘半径随最小边缩放；切走标签页即停笔；
   - prefers-reduced-motion：只绘一帧静态画面。
*/
(function () {
  'use strict';

  var canvas = document.getElementById('rig-canvas');
  var ctx = canvas.getContext('2d');

  var width = canvas.width = window.innerWidth;
  var height = canvas.height = window.innerHeight;

  var reduceMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var particles = [];
  var time = 0;
  var running = true;

  function diskR() {
    return Math.max(100, Math.min(200, Math.min(width, height) * 0.24));
  }

  function Particle() { this.reset(); }
  Particle.prototype.reset = function () {
    var maxR = Math.max(140, Math.min(width, height) * 0.42);
    this.baseRadius = Math.random() * (maxR - 120) + 120;
    this.radius = this.baseRadius;
    this.angle = Math.random() * Math.PI * 2;
    // 缓慢环流（速度范围刻意压低，求安逸；约为初版一半）
    this.speed = (Math.random() * 0.006 + 0.001) * (Math.random() < 0.5 ? 1 : -1);
    this.size = Math.random() * 1.5 + 0.5;
    this.x = width / 2;
    this.y = height / 2;
  };
  Particle.prototype.update = function () {
    this.angle += this.speed;
    var wave = Math.sin(time + this.baseRadius * 0.05) * 15;
    this.radius = this.baseRadius + wave;
    this.x = width / 2 + Math.cos(this.angle) * this.radius;
    this.y = height / 2 + Math.sin(this.angle) * this.radius;
  };
  Particle.prototype.draw = function () {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 243, 255, 0.7)';
    ctx.fill();
  };

  function initParticles() {
    particles = [];
    var count = Math.max(50, Math.min(160, Math.round(width * height / 9000)));
    for (var i = 0; i < count; i++) particles.push(new Particle());
  }

  function frame() {
    // 拖尾：半透明重绘而非清屏
    ctx.fillStyle = 'rgba(2, 6, 15, 0.2)';
    ctx.fillRect(0, 0, width, height);

    time += 0.012;   // 全局时钟放慢：圆盘/八卦/呼吸波浪一并放缓

    ctx.strokeStyle = 'rgba(0, 243, 255, 0.08)';
    ctx.lineWidth = 0.5;

    for (var i = 0; i < particles.length; i++) {
      particles[i].update();
      particles[i].draw();
      for (var j = i; j < particles.length; j++) {
        var dx = particles[i].x - particles[j].x;
        var dy = particles[i].y - particles[j].y;
        if (dx * dx + dy * dy < 2025) { // dist < 45
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.stroke();
        }
      }
    }

    drawTaiChiDisk();
  }

  /* ---------------- 全息太极阴阳鱼 ---------------- */
  function drawTaiChiDisk() {
    var R = diskR();

    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate(time * 0.2);   // 太极盘缓转
    ctx.lineWidth = 1.5;

    var cyanLight = 'rgba(0, 243, 255, 0.06)';
    var darkLight = 'rgba(2, 12, 28, 0.35)';
    var cyanStroke = 'rgba(0, 243, 255, 0.35)';
    var cyanGlow = 'rgba(0, 243, 255, 0.6)';

    // 阳鱼（含 S 型弧线）
    ctx.beginPath();
    ctx.arc(0, 0, R, -Math.PI / 2, Math.PI / 2);
    ctx.arc(0, R / 2, R / 2, Math.PI / 2, -Math.PI / 2, true);
    ctx.arc(0, -R / 2, R / 2, Math.PI / 2, -Math.PI / 2, false);
    ctx.fillStyle = cyanLight;
    ctx.fill();
    ctx.strokeStyle = cyanStroke;
    ctx.stroke();

    // 阴鱼
    ctx.beginPath();
    ctx.arc(0, 0, R, Math.PI / 2, -Math.PI / 2);
    ctx.arc(0, -R / 2, R / 2, -Math.PI / 2, Math.PI / 2, true);
    ctx.arc(0, R / 2, R / 2, -Math.PI / 2, Math.PI / 2, false);
    ctx.fillStyle = darkLight;
    ctx.fill();
    ctx.strokeStyle = cyanStroke;
    ctx.stroke();

    // 鱼眼
    ctx.beginPath();
    ctx.arc(0, -R / 2, R / 7, 0, Math.PI * 2);
    ctx.fillStyle = cyanLight;
    ctx.fill();
    ctx.strokeStyle = cyanGlow;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, R / 2, R / 7, 0, Math.PI * 2);
    ctx.fillStyle = darkLight;
    ctx.fill();
    ctx.strokeStyle = cyanStroke;
    ctx.stroke();

    // 主圆环
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 243, 255, 0.45)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.restore();

    // 八卦刻度轨（逆向旋转）
    ctx.save();
    ctx.translate(width / 2, height / 2);
    ctx.rotate(-time * 0.1);  // 八卦刻度轨，比盘更慢地反转

    var rOut = R + 30;
    ctx.strokeStyle = 'rgba(0, 243, 255, 0.2)';
    ctx.lineWidth = 1;

    for (var i = 0; i < 8; i++) {
      var angle = i * Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * (R + 8), Math.sin(angle) * (R + 8));
      ctx.lineTo(Math.cos(angle) * rOut, Math.sin(angle) * rOut);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(0, 0, rOut + 15, 0, Math.PI * 2);
    ctx.setLineDash([8, 16, 2, 16]);
    ctx.strokeStyle = 'rgba(0, 243, 255, 0.15)';
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.restore();
  }

  function loop() {
    if (!running) return;
    frame();
    requestAnimationFrame(loop);
  }

  window.addEventListener('resize', function () {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
    initParticles();
  });

  // 切走标签页停笔，回来继续
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      running = false;
    } else if (!reduceMotion && !running) {
      running = true;
      loop();
    }
  });

  initParticles();

  if (reduceMotion) {
    // 静态一帧：不递增 time、不循环
    ctx.fillStyle = '#02060f';
    ctx.fillRect(0, 0, width, height);
    for (var i = 0; i < particles.length; i++) particles[i].draw();
    drawTaiChiDisk();
  } else {
    loop();
  }
})();
