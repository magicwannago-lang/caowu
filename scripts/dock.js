/* ============================================================
   草屋 · 侧边栏与听音
   把声音接到界面：左缘那枚按钮（雨声）、观隅的入口、以及底部听音条。

   浮出规则：滚过卷首（hero）才出现，回到顶端即沉回屏外。
   底部听音条另有一套规矩：只有真在放曲目时才浮出（见 player.js）。
   ============================================================ */

(function () {
  'use strict';

  var dock = document.getElementById('dock');
  var toggle = document.getElementById('ambient-toggle');
  var vol = document.getElementById('ambient-vol');
  var dockProgress = document.getElementById('dock-progress');
  var dockSub = document.getElementById('dock-sub');

  var invites = document.querySelectorAll('[data-listen-start]');
  var listToggle = document.querySelector('[data-listen-list]');
  var playlist = document.getElementById('playlist');

  var claimed = false;   // 曲目接管后，雨声按钮改为「暂停曲目」

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

  function paint(state) {
    var on = state.playing;

    if (toggle) {
      toggle.classList.toggle('is-playing', on);
      toggle.setAttribute('aria-pressed', String(on));
      toggle.setAttribute('aria-label', on ? '暂停雨声与流水' : '播放雨声与流水');
    }
    if (dockSub) {
      dockSub.textContent = claimed
        ? (window.Player && Player.isPlaying() ? '正在放曲目' : '曲目已停 · 雨声待命')
        : (on ? '正在响 · 缓缓循环' : '雨丝与檐下流水，缓慢循环');
    }
    if (vol && document.activeElement !== vol) {
      vol.value = String(Math.round(state.volume * 100));
    }
  }

  if (window.Ambient) {
    Ambient.onChange(paint);
    Ambient.init();
  }

  /* 曲目的起停由 player.js 自己知道，这里定时对一下总闸的灯。
     半秒一次，只在按钮可见时跑——不为一个按钮养一条观察链。 */
  setInterval(function () {
    if (!toggle || document.hidden) return;
    var on = (window.Ambient && Ambient.isPlaying()) ||
             (claimed && window.Player && Player.isPlaying());
    toggle.classList.toggle('is-playing', !!on);
  }, 500);

  /* ---------- 3. 点击：侧栏那一枚是全站声音的总闸 ----------
     雨声与曲目共用同一个按钮：谁在响就先关谁；都没响就把
     上次开着的那一路接回来。用户只需记一个规矩。 */

  if (toggle) {
    toggle.addEventListener('click', function (e) {
      e.preventDefault();

      var trackOn = claimed && window.Player && Player.isPlaying();
      var rainOn = window.Ambient && Ambient.isPlaying();

      if (trackOn) { Player.start(); return; }        // 曲目在响：暂停它
      if (rainOn) { Ambient.pause(); return; }        // 雨声在响：暂停它
      if (claimed && window.Player) { Player.start(); return; }  // 曲目待命：接回来
      if (window.Ambient) Ambient.play();             // 否则：起雨声
    });
  }

  /* ---------- 4. 观隅：点开即播 ---------- */

  Array.prototype.forEach.call(invites, function (btn) {
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (window.Player) Player.start();
    });
  });

  if (listToggle && playlist) {
    listToggle.addEventListener('click', function () {
      var open = !playlist.hasAttribute('hidden');
      if (open) playlist.setAttribute('hidden', '');
      else playlist.removeAttribute('hidden');
      listToggle.setAttribute('aria-expanded', String(!open));
      listToggle.textContent = open ? '曲目' : '收起';
    });
  }

  /* ---------- 5. 音量：侧栏那条滑杆与底部共用一路 ---------- */

  if (vol) {
    vol.addEventListener('input', function () {
      var v = parseInt(vol.value, 10) / 100;
      if (window.Ambient) Ambient.setVolume(v);
      if (window.Player && Player.tracks().length) {
        var barVol = document.querySelector('.listener-vol input');
        if (barVol) barVol.value = String(Math.round(v * 100));
      }
    });
  }

  /* ---------- 6. 键盘可达：Tab 到侧栏即展开小卡 ---------- */

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

  /* ---------- 对外：曲目起声时通知一声 ---------- */

  window.Dock = {
    claim: function () {
      claimed = true;
      if (window.Ambient) {
        Ambient.pause();     // 让位要彻底：雨声直接收，不是压小
        Ambient.duck();
      }
      if (dockSub) dockSub.textContent = '正在放曲目';
    },
    release: function () {
      claimed = false;
    }
  };
})();
