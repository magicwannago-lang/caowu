/* ============================================================
   草屋 · 每日简语（衡几第四件器物）
   接线：选项联动、阶段进度、SSE 渲染日帖、视频前端轮询、
   卡内独立 audio 试听（与雨声/全局曲目互斥让位）。
   手起一帖，不存任何东西、关掉页面即散。
   ============================================================ */

(function () {
  'use strict';

  var hengji = window.Hengji;
  if (!hengji) return;

  var hintEl = document.getElementById('daily-hint');
  var optImage = document.getElementById('daily-opt-image');
  var optVideo = document.getElementById('daily-opt-video');
  var imgPromptRow = document.getElementById('daily-img-prompt-row');
  var imgPromptEl = document.getElementById('daily-img-prompt');
  var vidPromptRow = document.getElementById('daily-vid-prompt-row');
  var vidPromptEl = document.getElementById('daily-vid-prompt');
  var runBtn = document.getElementById('daily-run');
  var stagesEl = document.getElementById('daily-stages');
  var sheetEl = document.getElementById('daily-sheet');
  var audioEl = document.getElementById('daily-audio');

  if (!hintEl || !runBtn || !sheetEl) return;

  // uiMode：idle | working
  var uiMode = 'idle';
  var pollCtl = null;

  /* ---------- 选项联动：短片以配图为首帧；提示词行随勾选显隐 ---------- */

  function syncPromptRows() {
    imgPromptRow.hidden = !optImage.checked;
    if (!optImage.checked) imgPromptEl.value = '';
    vidPromptRow.hidden = !optVideo.checked;
    if (!optVideo.checked) vidPromptEl.value = '';
  }

  optImage.addEventListener('change', syncPromptRows);
  optVideo.addEventListener('change', function () {
    if (optVideo.checked) {
      optImage.checked = true;
      optImage.disabled = true;
    } else {
      optImage.disabled = false;
    }
    syncPromptRows();
  });

  runBtn.addEventListener('click', function () {
    if (uiMode === 'working') return;
    startPost();
  });

  /* ---------- 阶段进度 ---------- */

  function stageLi(name) {
    return stagesEl.querySelector('li[data-stage="' + name + '"]');
  }

  function clearStages() {
    stagesEl.querySelectorAll('li').forEach(function (li) {
      li.classList.remove('is-active', 'is-done');
      var meta = li.querySelector('.book-stage-meta');
      meta.textContent = '';
      meta.classList.remove('is-warn');
    });
  }

  // state：active | done | waiting | warn
  function setStage(name, state, text) {
    var li = stageLi(name);
    var meta = li.querySelector('.book-stage-meta');
    li.classList.remove('is-active', 'is-done');
    meta.classList.remove('is-warn');
    if (state === 'active' || state === 'waiting') li.classList.add('is-active');
    if (state === 'done') li.classList.add('is-done');
    if (state === 'warn') meta.classList.add('is-warn');
    meta.textContent = text || '';
  }

  /* ---------- 起帖 ---------- */

  function startPost() {
    uiMode = 'working';
    stopAudioIfAny();
    stopPolling();
    runBtn.disabled = true;
    runBtn.textContent = '起帖中…';
    clearStages();
    stagesEl.removeAttribute('hidden');
    sheetEl.setAttribute('hidden', '');
    sheetEl.textContent = '';

    var hint = hintEl.value.trim();
    var toneEl = document.querySelector('input[name="daily-tone"]:checked');
    var opts = {
      tone: toneEl ? toneEl.value : 'heal',
      withImage: optImage.checked,
      withVideo: optVideo.checked,
      // 勾选取消时不传：后端以空为「用默认」
      imageHint: optImage.checked ? imgPromptEl.value.trim() : '',
      videoHint: optVideo.checked ? vidPromptEl.value.trim() : ''
    };
    var plan = null;

    hengji.dailyCreate(hint, opts, {
      onStage: function (name, state) {
        var text = {
          saying: { active: '想句中…', done: '已成' },
          image: { active: '作画中…', done: '已成', warn: '未就' },
          video: { active: '遣往影苑…', waiting: '酝酿中', warn: '未成' }
        }[name][state] || '';
        setStage(name, state, text);
      },
      onPlan: function (obj) {
        plan = obj;
        reveal();
        renderSaying(obj.saying);
        renderMusic(obj.music);
        sheetEl.removeAttribute('hidden');
      },
      onImage: function (url, error) {
        if (!plan) return; // 防御：plan 必在图前
        if (url) renderImage(url);
        else renderImageWarn(error || '画未成就');
      },
      onVideoTask: function (taskId) {
        renderPending(taskId);
      }
    }).then(function (done) {
      // 以 done 全量数据补齐（防个别事件丢失）
      if (!plan) {
        renderSaying(done.saying);
        renderMusic(done.music);
      }
      if (opts.withImage) {
        if (done.imageUrl && !sheetEl.querySelector('.daily-frame,.daily-note-warn')) {
          renderImage(done.imageUrl);
        } else if (done.imageError && !sheetEl.querySelector('.daily-frame,.daily-note-warn')) {
          renderImageWarn(done.imageError);
        }
      }
      sheetEl.removeAttribute('hidden');

      if (done.video && done.video.taskId) {
        beginPolling(done.video.taskId);
      } else if (done.video && done.video.error) {
        replacePendingWithNote('短片未成，静图已好');
      } else {
        removePending();
      }

      finishButton();
    }).catch(function (err) {
      sheetEl.textContent = '';
      var p = document.createElement('p');
      p.className = 'daily-note-warn';
      p.innerHTML = '<strong>今日先生无言</strong>　' +
        (((err && err.message) || '').toString() || '稍候再试') + '，再试一帖';
      sheetEl.appendChild(p);
      sheetEl.removeAttribute('hidden');
      finishButton();
    });

    // 占位：阶段事件先于内容时，保证 DOM 序：简语 → 图/短片 → 音乐
    function reveal() { sheetEl.textContent = ''; }
    function finishButton() {
      uiMode = 'idle';
      runBtn.disabled = false;
      runBtn.textContent = '再出一帖';
    }
  }

  /* ---------- 日帖各件渲染 ---------- */

  function renderSaying(text) {
    var el = document.createElement('p');
    el.className = 'daily-saying';
    el.textContent = text;
    sheetEl.appendChild(el);
  }

  function renderImage(url) {
    var fig = document.createElement('figure');
    fig.className = 'daily-frame';
    var img = document.createElement('img');
    img.alt = '今日配图';
    fig.appendChild(img);

    insertBeforeMusic(fig);

    // 预载完成再淡入，不闪半幅
    var pre = new Image();
    pre.onload = function () { img.src = url; img.classList.add('is-ready'); };
    pre.onerror = function () {
      fig.replaceWith(imageWarnEl('画交来了，却没展开'));
    };
    pre.src = url;
  }

  function renderImageWarn(msg) {
    insertBeforeMusic(imageWarnEl(msg));
  }

  function imageWarnEl(msg) {
    var p = document.createElement('p');
    p.className = 'daily-note-warn';
    p.innerHTML = '<strong>画未成就</strong>　只有这句语——' + msg;
    return p;
  }

  function renderPending(taskId) {
    removePending();
    var row = document.createElement('div');
    row.className = 'daily-video-pending';

    var dot = document.createElement('span');
    dot.className = 'book-stage-dot';
    var txt = document.createElement('span');
    txt.textContent = '短片酝酿中…';
    var stop = document.createElement('button');
    stop.className = 'btn btn-ghost';
    stop.type = 'button';
    stop.textContent = '不等了';
    stop.addEventListener('click', function () {
      stopPolling();
      replacePendingWithNote('静图已好，短片来日再说');
    });

    row.appendChild(dot);
    row.appendChild(txt);
    row.appendChild(stop);
    insertBeforeMusic(row);
  }

  function replacePendingWithVideo(videoUrl) {
    var pending = sheetEl.querySelector('.daily-video-pending');
    var fig = document.createElement('figure');
    fig.className = 'daily-frame';
    var video = document.createElement('video');
    video.src = videoUrl;
    video.controls = true;
    video.preload = 'none';
    var imgEl = sheetEl.querySelector('.daily-frame img');
    if (imgEl) video.poster = imgEl.src;
    fig.appendChild(video);
    if (pending) pending.replaceWith(fig);
    else insertBeforeMusic(fig);
  }

  function replacePendingWithNote(text) {
    var pending = sheetEl.querySelector('.daily-video-pending');
    if (!pending) return;
    var p = document.createElement('p');
    p.className = 'daily-note-warn';
    p.innerHTML = '<strong>短片未成</strong>　' + text;
    pending.replaceWith(p);
  }

  function removePending() {
    var pending = sheetEl.querySelector('.daily-video-pending');
    if (pending) pending.remove();
  }

  function renderMusic(music) {
    var box = document.createElement('div');
    box.className = 'daily-music';

    var eyebrow = document.createElement('span');
    eyebrow.className = 'daily-music-eyebrow';
    eyebrow.textContent = '荐曲';
    var title = document.createElement('span');
    title.className = 'daily-music-title';
    title.textContent = music.title || '';
    var artist = document.createElement('span');
    artist.className = 'daily-music-artist';
    artist.textContent = music.artist ? '· ' + music.artist : '';

    box.appendChild(eyebrow);
    box.appendChild(title);
    box.appendChild(artist);

    // 无本地音源的大众曲目只陈信息；有 file 才呈试听
    if (music.file) {
      var play = document.createElement('button');
      play.className = 'btn btn-ghost';
      play.type = 'button';
      play.textContent = '试听';
      box.appendChild(play);
      wireListen(play, music, box);
    }

    if (music.reason) {
      var reason = document.createElement('span');
      reason.className = 'daily-music-reason';
      reason.textContent = music.reason;
      box.appendChild(reason);
    }

    sheetEl.appendChild(box);
  }

  // 图/短片件插在音乐行之前，守 DOM 次序
  function insertBeforeMusic(el) {
    var music = sheetEl.querySelector('.daily-music');
    if (music) sheetEl.insertBefore(el, music);
    else sheetEl.appendChild(el);
  }

  /* ---------- 试听：独立 audio，互斥让位 ---------- */

  function wireListen(play, music, box) {
    var ready = null;

    play.addEventListener('click', function () {
      if (!audioEl.paused) { // 正在放本曲：收
        audioEl.pause();
        return;
      }
      if (window.Player && Player.isPlaying()) {
        noteIn(box, '先收底部听音条，再试此曲');
        return;
      }

      if (!ready) {
        // 曲目解析失败与播放失败分开：前者可重试，后者（如手势被拦）不永久禁用
        ready = resolveTrack(music.file).then(function (src) {
          if (!src) {
            var e = new Error('曲目未取到');
            e.resolveFailed = true;
            throw e;
          }
          audioEl.src = src;
        });
      }
      ready.then(function () {
        return audioEl.play();
      }).then(function () {
        play.textContent = '停';
        var old = box.querySelector('.daily-music-warn-note');
        if (old) old.remove();
        if (window.Ambient) Ambient.duck();
        if (window.Dock) Dock.claim();
      }).catch(function (err) {
        if (err && err.resolveFailed) {
          ready = null; // 允许下次点击重试
          noteIn(box, '曲目未取到，稍后可再试');
        } else {
          noteIn(box, '没放出声，再点一次试试');
        }
      });
    });
  }

  function noteIn(box, text) {
    var old = box.querySelector('.daily-music-warn-note');
    if (old) old.remove();
    var span = document.createElement('span');
    span.className = 'daily-music-reason daily-music-warn-note';
    span.textContent = text;
    box.appendChild(span);
  }

  // 曲目 src：新曲库编号与 manifest 无关，直接按 assets/audio 下的文件名取
  function resolveTrack(file) {
    return Promise.resolve(file ? 'assets/audio/' + encodeURIComponent(file) : null);
  }

  audioEl.addEventListener('pause', function () {
    if (window.Ambient) Ambient.unduck();
    if (window.Dock) Dock.release();
    var play = sheetEl.querySelector('.daily-music .btn');
    if (play) play.textContent = '试听';
  });
  audioEl.addEventListener('ended', function () {
    if (window.Ambient) Ambient.unduck();
    if (window.Dock) Dock.release();
  });

  function stopAudioIfAny() {
    if (audioEl && !audioEl.paused) audioEl.pause();
    audioEl.removeAttribute('src');
  }

  /* ---------- 视频轮询（前端驱动） ---------- */

  var POLL_DELAYS = [5000, 6000, 8000, 10000];
  var POLL_MAX_TRIES = 45; // 约 5 分钟

  function beginPolling(taskId) {
    stopPolling();
    pollCtl = { taskId: taskId, tries: 0, timer: null, stopped: false, waitHidden: false };

    var ctl = pollCtl;

    function schedule(ms) {
      ctl.timer = setTimeout(tick, ms);
    }
    function tick() {
      ctl.timer = null;
      if (document.hidden) { ctl.waitHidden = true; return; }
      runOnce();
    }
    function runOnce() {
      hengji.dailyPoll(ctl.taskId).then(function (r) {
        if (ctl.stopped) return;
        if (r.status === 'succeeded') {
          stopPolling();
          replacePendingWithVideo(r.videoUrl);
          setStage('video', 'done', '已成');
        } else if (r.status === 'failed') {
          stopPolling();
          replacePendingWithNote('静图已好');
          setStage('video', 'warn', '未成');
        } else {
          ctl.tries++;
          if (ctl.tries >= POLL_MAX_TRIES) {
            stopPolling();
            replacePendingWithNote('等得久了，静图已好');
            setStage('video', 'warn', '超时');
          } else {
            schedule(POLL_DELAYS[Math.min(ctl.tries, POLL_DELAYS.length - 1)]);
          }
        }
      }).catch(function () {
        if (ctl.stopped) return;
        // 单次查询失败：当作一轮，稍后再试，不轻易放弃
        ctl.tries++;
        schedule(POLL_DELAYS[Math.min(ctl.tries, POLL_DELAYS.length - 1)]);
      });
    }

    function onVis() {
      if (ctl.stopped) return;
      if (!document.hidden && ctl.waitHidden) {
        ctl.waitHidden = false;
        if (!ctl.timer) runOnce();
      }
      if (document.hidden && ctl.timer) {
        clearTimeout(ctl.timer);
        ctl.timer = null;
        ctl.waitHidden = true;
      }
    }
    ctl.onVis = onVis;
    document.addEventListener('visibilitychange', onVis);

    runOnce();
  }

  function stopPolling() {
    if (!pollCtl) return;
    pollCtl.stopped = true;
    if (pollCtl.timer) clearTimeout(pollCtl.timer);
    if (pollCtl.onVis) document.removeEventListener('visibilitychange', pollCtl.onVis);
    pollCtl = null;
  }
})();
