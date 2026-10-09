/* ============================================================
   草屋 · 音频内感
   焚香，打坐，倾听最真实的自己。

   系列数据在 assets/inner-audio.json：每个系列一张固定格式封面，
   右陈名称、简介、文件列表。读取失败或清单为空时，退内置示例
   系列（借用曲库现成文件）——草屋不假装有内容。
   播放三式：列表循环 / 单一循环 / 随机播放，也可点任一文件直放。
   ============================================================ */

(function () {
  'use strict';

  var DATA_URL = 'assets/inner-audio.json';
  var MODE_KEY = 'caowu.inneraudio.mode';

  var card = document.getElementById('inner-audio');
  if (!card) return;

  var coverEl = card.querySelector('.inner-cover');
  var tabsEl = card.querySelector('.inner-tabs');
  var nameEl = card.querySelector('.inner-name');
  var introEl = card.querySelector('.inner-intro');
  var listEl = card.querySelector('.inner-files');
  var noteEl = card.querySelector('.inner-note');
  var playBtn = card.querySelector('[data-ia-play]');
  var prevBtn = card.querySelector('[data-ia-prev]');
  var nextBtn = card.querySelector('[data-ia-next]');
  var modeBtn = card.querySelector('[data-ia-mode]');
  var timeEl = card.querySelector('.inner-time');
  var audioEl = document.getElementById('inner-audio-el');

  /* 三种播放方式，依次轮换 */
  var MODES = [
    { key: 'list', label: '列表循环' },
    { key: 'one', label: '单一循环' },
    { key: 'shuffle', label: '随机播放' }
  ];

  /* 清单取不来时的后备：仍是示例，封面与音频皆为现成素材 */
  var DEMO = {
    series: [
      {
        id: 'demo',
        name: '静坐 · 入处（示例）',
        intro: '清单未读到，先陈示例系列。替换 assets/inner-audio.json 即可。',
        cover: 'assets/img/03-雾林双檐.jpg',
        tracks: [
          { title: '雨落草檐', sub: '雨丝与檐下流水', file: 'assets/audio/01-雨落草檐.mp3' },
          { title: '檐下流水', sub: '檐角滴水，石上成声', file: 'assets/audio/02-檐下流水.mp3' },
          { title: '空山鸟语', sub: '山空无人，鸟声自来自去', file: 'assets/audio/03-空山鸟语.mp3' }
        ]
      }
    ]
  };

  var seriesList = [];
  var seriesIdx = 0;
  var trackIdx = 0;
  var modeIdx = readMode();

  function tracks() {
    var s = seriesList[seriesIdx];
    return s ? s.tracks : [];
  }

  function readMode() {
    try {
      var k = localStorage.getItem(MODE_KEY);
      for (var i = 0; i < MODES.length; i++) if (MODES[i].key === k) return i;
    } catch (e) { /* 忽略 */ }
    return 0;
  }

  function note(text) {
    if (!noteEl) return;
    noteEl.textContent = text || '';
    noteEl.hidden = !text;
  }

  /* ---------- 渲染：封面 / 标签 / 列表 ---------- */

  function renderTabs() {
    if (!tabsEl) return;
    tabsEl.textContent = '';
    tabsEl.hidden = seriesList.length < 2;
    seriesList.forEach(function (s, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'inner-tab' + (i === seriesIdx ? ' is-current' : '');
      b.textContent = s.name;
      b.addEventListener('click', function () {
        if (i === seriesIdx) return;
        stopAudio();
        seriesIdx = i;
        trackIdx = 0;
        renderAll();
      });
      tabsEl.appendChild(b);
    });
  }

  function renderCover() {
    if (!coverEl) return;
    coverEl.textContent = '';
    var s = seriesList[seriesIdx];
    var img = document.createElement('img');
    img.alt = s ? s.name : '封面';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('error', function () {
      coverEl.textContent = '';
      var ph = document.createElement('span');
      ph.className = 'inner-cover-ph';
      ph.textContent = '封面陈位 · 固定格式';
      coverEl.appendChild(ph);
    });
    img.src = s && s.cover ? s.cover : '';
    coverEl.appendChild(img);
  }

  function renderMeta() {
    var s = seriesList[seriesIdx];
    if (nameEl) nameEl.textContent = s ? s.name : '';
    if (introEl) introEl.textContent = s ? s.intro : '';
  }

  function renderFiles() {
    if (!listEl) return;
    listEl.textContent = '';
    tracks().forEach(function (t, i) {
      var li = document.createElement('li');
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'inner-file';
      b.dataset.i = String(i);

      var name = document.createElement('span');
      name.className = 'inner-file-name';
      name.textContent = t.title;
      var sub = document.createElement('span');
      sub.className = 'inner-file-sub';
      sub.textContent = t.sub || '';
      var bar = document.createElement('span');
      bar.className = 'inner-file-bar';
      bar.setAttribute('aria-hidden', 'true');

      b.appendChild(name);
      b.appendChild(sub);
      b.appendChild(bar);
      b.addEventListener('click', function () { onFileClick(i); });
      li.appendChild(b);
      listEl.appendChild(li);
    });
    paintCurrent();
  }

  function renderAll() {
    renderTabs();
    renderCover();
    renderMeta();
    renderFiles();
    paintPlay();
    paintProgress();
  }

  /* ---------- 播放 ---------- */

  function onFileClick(i) {
    if (!audioEl.paused && i === trackIdx) { // 正在放此曲：收
      audioEl.pause();
      return;
    }
    playTrack(i);
  }

  function playTrack(i) {
    // 底部全局听音条正在响：不与其叠声，请用户先收（与每日简语同例）
    if (window.Player && Player.isPlaying()) {
      note('先收底部听音条，再听内感');
      return;
    }
    note('');
    trackIdx = i;
    var t = tracks()[i];
    if (!t || !t.file) return;
    audioEl.src = t.file;
    audioEl.play().catch(function () {
      note('没放出声，再点一次试试');
    });
    paintCurrent();
  }

  function togglePlay() {
    if (!audioEl.src) { playTrack(0); return; }
    if (audioEl.paused) {
      if (window.Player && Player.isPlaying()) { note('先收底部听音条，再听内感'); return; }
      audioEl.play().catch(function () { note('没放出声，再点一次试试'); });
    } else {
      audioEl.pause();
    }
  }

  function stopAudio() {
    if (audioEl && !audioEl.paused) audioEl.pause();
    audioEl.removeAttribute('src');
    trackIdx = 0;
  }

  function pickNext() {
    var n = tracks().length;
    if (n < 2) return 0;
    if (MODES[modeIdx].key === 'shuffle') {
      var r = trackIdx;
      while (r === trackIdx) r = Math.floor(Math.random() * n);
      return r;
    }
    return (trackIdx + 1) % n;
  }

  function nextManual() {
    if (!tracks().length) return;
    if (audioEl.paused && !audioEl.src) { playTrack(pickNext()); return; }
    playTrack(pickNext());
  }

  function prevManual() {
    var n = tracks().length;
    if (!n) return;
    var i = MODES[modeIdx].key === 'shuffle' ? pickNext() : (trackIdx - 1 + n) % n;
    playTrack(i);
  }

  /* ---------- 状态绘制 ---------- */

  function paintCurrent() {
    if (!listEl) return;
    var rows = listEl.querySelectorAll('.inner-file');
    rows.forEach(function (b, i) {
      b.classList.toggle('is-current', i === trackIdx);
      b.classList.toggle('is-playing', i === trackIdx && !audioEl.paused);
    });
  }

  function paintPlay() {
    if (!playBtn) return;
    var playing = !audioEl.paused;
    playBtn.classList.toggle('is-playing', playing);
    playBtn.setAttribute('aria-pressed', String(playing));
    playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
  }

  function fmt(t) {
    if (!isFinite(t)) return '--:--';
    var m = Math.floor(t / 60);
    var s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function paintProgress() {
    var row = listEl && listEl.querySelector('.inner-file.is-current');
    if (row) {
      var bar = row.querySelector('.inner-file-bar');
      if (bar && isFinite(audioEl.duration)) {
        bar.style.width = (audioEl.currentTime / audioEl.duration * 100) + '%';
      }
    }
    if (timeEl) timeEl.textContent = fmt(audioEl.currentTime) + ' / ' + fmt(audioEl.duration);
  }

  function cycleMode() {
    modeIdx = (modeIdx + 1) % MODES.length;
    try { localStorage.setItem(MODE_KEY, MODES[modeIdx].key); } catch (e) { /* 忽略 */ }
    if (modeBtn) {
      modeBtn.textContent = MODES[modeIdx].label;
      modeBtn.setAttribute('aria-label', '播放方式：' + MODES[modeIdx].label + '，点击切换');
    }
  }

  /* ---------- audio 事件：互斥让位 ---------- */

  audioEl.addEventListener('play', function () {
    if (window.Ambient) Ambient.duck();
    if (window.Dock) Dock.claim();
    paintPlay();
    paintCurrent();
  });

  audioEl.addEventListener('pause', function () {
    if (window.Ambient) Ambient.unduck();
    if (window.Dock) Dock.release();
    paintPlay();
    paintCurrent();
  });

  audioEl.addEventListener('timeupdate', paintProgress);

  audioEl.addEventListener('ended', function () {
    if (MODES[modeIdx].key === 'one') {
      audioEl.currentTime = 0;
      audioEl.play().catch(function () { note('没放出声，再点一次试试'); });
      return;
    }
    if (tracks().length > 1) {
      playTrack(pickNext());              // 列表/随机：pickNext 已含回绕
    } else {
      audioEl.currentTime = 0;
      paintPlay();
      paintCurrent();
    }
  });

  if (playBtn) playBtn.addEventListener('click', togglePlay);
  if (prevBtn) prevBtn.addEventListener('click', prevManual);
  if (nextBtn) nextBtn.addEventListener('click', nextManual);
  if (modeBtn) {
    modeBtn.textContent = MODES[modeIdx].label;
    modeBtn.addEventListener('click', cycleMode);
  }

  /* ---------- 取材：清单 → 内置示例 ---------- */

  function load(list) {
    var series = list && list.series ? list.series.filter(function (s) {
      return s && s.tracks && s.tracks.length;
    }) : [];
    seriesList = series.length ? series : DEMO.series;
    seriesIdx = 0;
    renderAll();
  }

  fetch(DATA_URL, { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(load)
    .catch(function () { load(null); });

})();
