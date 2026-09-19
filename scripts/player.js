/* ============================================================
   草屋 · 播放器
   全站唯一一路真音频：读 assets/audio/ 的曲目，一首接一首。

   三件事，对应需求里的三小点：
     ① 点击播放后持续播放 —— 播完自动接下一首；一首歌单曲循环由 loop 兜底
     ② 底部显示歌曲信息   —— 底部听音条常驻曲名、来源、时间
     ③ 底部歌曲添加播放功能按钮 —— 上一首 / 播放暂停 / 下一首 / 进度 / 音量

   声音只有一路：合成雨声（ambient.js）与曲目共用一个音量、
   互为让位——曲目起声，雨声自动退到后面；曲目停，雨声回来。
   ============================================================ */

(function () {
  'use strict';

  var bar = document.getElementById('listener');
  if (!bar) return;

  var el = {
    bar: bar,
    seal: bar.querySelector('.listener-seal'),
    title: bar.querySelector('.listener-title'),
    sub: bar.querySelector('.listener-sub'),
    time: bar.querySelector('.listener-time'),
    seek: bar.querySelector('.listener-seek'),
    fill: bar.querySelector('.listener-seek-fill'),
    prev: bar.querySelector('[data-act="prev"]'),
    next: bar.querySelector('[data-act="next"]'),
    play: bar.querySelector('[data-act="play"]'),
    vol: bar.querySelector('.listener-vol input'),
    close: bar.querySelector('[data-act="close"]')
  };

  var audio = null;          // 延迟创建，避免无谓的网络请求
  var tracks = [];           // [{ file, title, sub, src, place }]
  var index = 0;
  var ready = false;
  var tried = 0;             // 连续失败计数，全失败就收手

  var STORE_KEY = 'caowu.track.index';
  var VOL_KEY = 'caowu.ambient.vol';   // 与雨声共用同一个音量

  /* ---------- 小工具 ---------- */

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) return '--:--';
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function remember(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* 忽略 */ }
  }

  function readVol() {
    try {
      var v = parseFloat(localStorage.getItem(VOL_KEY));
      return isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.42;
    } catch (e) { return 0.42; }
  }

  function hasRealTrack() {
    for (var i = 0; i < tracks.length; i++) {
      if (tracks[i].src) return true;
    }
    return false;
  }

  function current() { return tracks[index] || null; }

  /* ---------- 界面 ---------- */

  function paint() {
    var t = current();
    var playing = audio && !audio.paused && !audio.ended;

    bar.classList.toggle('is-playing', !!playing);
    bar.classList.toggle('is-up', ready);
    // 页脚要按播放条的高度让位（CSS 里的 body.has-listener）
    document.body.classList.toggle('has-listener', !!ready);
    // 页面上别处的小图标跟着一起变（观隅那一枚开始键）
    document.body.classList.toggle('is-hearing', !!playing);

    el.title.textContent = t
      ? (t.title || '未命名')
      : (ready ? '曲目未就绪' : '正在翻检曲库…');
    el.sub.textContent = t
      ? (t.sub || (t.place ? '把音频放进 assets/audio/ 即可入列' : '草屋 · 听音'))
      : '';

    if (el.play) {
      el.play.setAttribute('aria-label', playing ? '暂停' : '播放');
      el.play.setAttribute('aria-pressed', String(!!playing));
      el.play.disabled = !hasRealTrack();
    }
    if (el.prev) el.prev.disabled = !hasRealTrack() || tracks.length < 2;
    if (el.next) el.next.disabled = !hasRealTrack() || tracks.length < 2;

    if (el.time && audio) {
      el.time.textContent = fmt(audio.currentTime) + ' / ' + fmt(audio.duration);
    } else if (el.time) {
      el.time.textContent = '--:-- / --:--';
    }

    // 曲目清单里的当前项
    var items = document.querySelectorAll('.playlist-item');
    Array.prototype.forEach.call(items, function (btn, i) {
      btn.classList.toggle('is-current', i === index);
      btn.setAttribute('aria-current', i === index ? 'true' : 'false');
    });
  }

  function paintProgress() {
    if (!el.fill || !audio || !isFinite(audio.duration) || audio.duration <= 0) return;
    var p = (audio.currentTime / audio.duration) * 100;
    el.fill.style.width = p.toFixed(2) + '%';
    if (el.seek) el.seek.setAttribute('aria-valuenow', Math.round(p));
    if (el.time) el.time.textContent = fmt(audio.currentTime) + ' / ' + fmt(audio.duration);
  }

  /* ---------- 音频元素：第一次点播放才建 ---------- */

  function ensureAudio() {
    if (audio) return audio;

    audio = document.createElement('audio');
    audio.preload = 'metadata';
    // 一首一首来的底气：真到末尾自动接下一首，见下面的 'ended'
    audio.addEventListener('loadedmetadata', function () { paintProgress(); paint(); });
    audio.addEventListener('timeupdate', paintProgress);
    audio.addEventListener('play', function () {
      if (window.Ambient) Ambient.duck();   // 雨声让位
      if (window.Dock) Dock.claim();
      paint();
    });
    audio.addEventListener('pause', function () {
      if (window.Ambient) Ambient.unduck();
      paint();
    });
    audio.addEventListener('ended', function () { next(true); });
    audio.addEventListener('error', function () {
      // 文件坏了或路径不对：跳过它，别把整条路堵死
      if (tried++ < tracks.length) next(true);
      else paint();
    });

    document.body.appendChild(audio);
    audio.volume = readVol();
    return audio;
  }

  /* ---------- 播放控制 ---------- */

  function select(i, autoplay) {
    if (!tracks.length) return;
    index = (i + tracks.length) % tracks.length;
    remember(STORE_KEY, String(index));

    var t = current();
    paint();

    if (!t || !t.src) return;      // 只是「位置」占位，不发声

    var a = ensureAudio();
    a.src = t.src;
    a.load();
    if (autoplay) {
      a.play().catch(function () {
        // 浏览器拒绝或文件缺失：交给 error 分支接管
        paint();
      });
    }
  }

  function togglePlay() {
    if (!hasRealTrack()) return;
    var a = ensureAudio();

    if (!a.src) { select(index, true); return; }

    if (a.paused) a.play().catch(function () { paint(); });
    else a.pause();
  }

  function next(auto) {
    // 只有一首：重头再来，别停 —— 「持续播放」
    if (tracks.length < 2) {
      if (audio) { audio.currentTime = 0; audio.play().catch(function () {}); }
      return;
    }
    select(index + 1, auto !== false);
  }

  function prev() {
    if (tracks.length < 2) {
      if (audio) { audio.currentTime = 0; paintProgress(); }
      return;
    }
    // 播过 3 秒就回到本首开头，否则退上一首（跟常见的播放器一致）
    if (audio && audio.currentTime > 3) { audio.currentTime = 0; paintProgress(); return; }
    select(index - 1, true);
  }

  function setVolume(v) {
    v = Math.min(1, Math.max(0, v));
    if (audio) audio.volume = v;
    if (window.Ambient) Ambient.setVolume(v);
    if (el.vol) el.vol.value = String(Math.round(v * 100));
  }

  /* ---------- 事件 ---------- */

  if (el.play) el.play.addEventListener('click', togglePlay);
  if (el.prev) el.prev.addEventListener('click', function () { prev(); });
  if (el.next) el.next.addEventListener('click', function () { next(true); });
  if (el.close) el.close.addEventListener('click', function () {
    if (audio && !audio.paused) audio.pause();
    ready = false;
    bar.classList.remove('is-up');
    if (window.Ambient) Ambient.unduck();
    paint();
  });

  if (el.vol) {
    el.vol.value = String(Math.round(readVol() * 100));
    el.vol.addEventListener('input', function () {
      setVolume(parseInt(el.vol.value, 10) / 100);
    });
  }

  // 进度：点击 / 拖动即定位
  if (el.seek) {
    var seeking = false;

    function ratioAt(clientX) {
      var r = el.seek.getBoundingClientRect();
      return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    }

    var onMove = function (e) {
      if (!seeking || !audio || !isFinite(audio.duration)) return;
      var x = e.touches ? e.touches[0].clientX : e.clientX;
      audio.currentTime = ratioAt(x) * audio.duration;
      paintProgress();
    };

    var onUp = function () {
      if (!seeking) return;
      seeking = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    el.seek.addEventListener('pointerdown', function (e) {
      if (!audio || !isFinite(audio.duration)) return;
      seeking = true;
      audio.currentTime = ratioAt(e.clientX) * audio.duration;
      paintProgress();
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    el.seek.addEventListener('keydown', function (e) {
      if (!audio || !isFinite(audio.duration)) return;
      var step = e.shiftKey ? 30 : 5;
      if (e.key === 'ArrowRight') { audio.currentTime = Math.min(audio.duration, audio.currentTime + step); paintProgress(); e.preventDefault(); }
      if (e.key === 'ArrowLeft')  { audio.currentTime = Math.max(0, audio.currentTime - step); paintProgress(); e.preventDefault(); }
    });
  }

  // 空格 / 左右键：别在输入框里抢键
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    if (!ready || !hasRealTrack()) return;

    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.key === 'ArrowRight' && e.altKey) { e.preventDefault(); next(true); }
    if (e.key === 'ArrowLeft' && e.altKey) { e.preventDefault(); prev(); }
  });

  /* ---------- 对外 ---------- */

  window.Player = {
    // 播放器自己浮出来并开始这一首
    start: function (i) {
      if (typeof i === 'number') select(i, true);
      else { ready = true; paint(); togglePlay(); }
    },
    tracks: function () { return tracks; },
    currentIndex: function () { return index; },
    isPlaying: function () { return !!audio && !audio.paused; }
  };

  /* ---------- 开张 ---------- */

  /* 陈列：assets/img/ 里有图就摊开，没有就保持几处空陈位。
     图的名字与位置都由 manifest.json 决定，网页不猜。 */
  function renderGallery(imgs) {
    var host = document.querySelector('[data-gallery]');
    if (!host || !imgs || !imgs.length) return;

    host.textContent = '';
    imgs.forEach(function (im, i) {
      var wide = im.wide || i === 0;      // 第一幅默认给横长陈位

      var fig = document.createElement('figure');
      fig.className = 'relic' +
        (wide ? ' relic-wide' : (im.tall ? ' relic-tall' : (im.scale ? ' relic-scale' : '')));
      fig.style.margin = '0';

      var media = document.createElement('div');
      media.className = 'relic-media';
      // 陈位形状跟着图走：_meta.json 可以点名 wide / tall / scale，
      // 但没点名的按 4:3、点错名的照点错名裁 —— 都会削掉画面。
      // 所以清单里带了真实宽高比时，用它覆盖 CSS 的默认比。
      if (im.ratio) media.style.aspectRatio = String(im.ratio);

      var img = document.createElement('img');
      img.src = im.src;
      img.alt = im.alt || im.title || '藏品';
      img.loading = 'lazy';
      img.decoding = 'async';
      // 图坏了不留破框：退回占位
      img.addEventListener('error', function () {
        media.textContent = '';
        var ph = document.createElement('span');
        ph.className = 'relic-placeholder';
        ph.textContent = '此帧未入 · ' + (im.title || '');
        media.appendChild(ph);
      });

      media.appendChild(img);
      fig.appendChild(media);

      if (im.title || im.note) {
        var body = document.createElement('figcaption');
        body.className = 'relic-body';
        if (im.title) {
          var h = document.createElement('h3');
          h.className = 'relic-title';
          h.textContent = im.title;
          body.appendChild(h);
        }
        if (im.note) {
          var p = document.createElement('p');
          p.className = 'relic-note';
          p.textContent = im.note;
          body.appendChild(p);
        }
        fig.appendChild(body);
      }

      host.appendChild(fig);
    });
  }

  Library.load().then(function (data) {
    tracks = data.audio || [];
    ready = tracks.length > 0;
    renderGallery(data.img);

    // 曲库空着：底部条不出场，只在观隅留一句实话
    var invite = document.querySelector('[data-listen-count]');
    if (invite) {
      invite.textContent = hasRealTrack()
        ? '共 ' + tracks.filter(function (t) { return t.src; }).length + ' 首，点开即接续播放'
        : '曲库还空着 —— 把音频放进 assets/audio/，跑一次 scripts/gen-manifest.py';
    }

    if (!hasRealTrack()) { paint(); return; }

    // 上次听到哪儿，接着来（不自动起声——浏览器政策，也合礼数）
    var last = 0;
    try { last = parseInt(localStorage.getItem(STORE_KEY), 10) || 0; } catch (e) { last = 0; }
    index = tracks.length ? Math.min(tracks.length - 1, Math.max(0, last)) : 0;

    // 曲目清单
    var list = document.getElementById('playlist');
    if (list) {
      list.textContent = '';
      tracks.forEach(function (t, i) {
        if (t.place) return;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'playlist-item';
        btn.innerHTML =
          '<span class="pl-index">' + (i + 1 < 10 ? '0' : '') + (i + 1) + '</span>' +
          '<span class="pl-name"></span>' +
          '<span class="pl-time">' + (t.sub || '') + '</span>';
        btn.querySelector('.pl-name').textContent = t.title || '未命名';
        btn.addEventListener('click', function () { Player.start(i); });
        list.appendChild(btn);
      });
    }

    paint();
  }).catch(function () {
    ready = false;
    paint();
  });
})();
