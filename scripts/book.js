/* ============================================================
   草屋 · 大儒呈作（衡几第三件器物）
   接线：文稿上传（点击/拖入，就地读取）、SSE 三校进度、
   定稿预览、书卷下载。逻辑在 hengji.js（Hengji.book），
   大儒不在则退本地著书框架。不存任何东西、关掉页面即散。
   ============================================================ */

(function () {
  'use strict';

  var hengji = window.Hengji;
  if (!hengji) return;

  var spiritEl = document.getElementById('book-spirit');
  var dropEl = document.getElementById('book-drop');
  var fileEl = document.getElementById('book-file');
  var fileNote = document.getElementById('book-file-note');
  var runBtn = document.getElementById('book-run');
  var awaitEl = document.getElementById('book-await');
  var stagesEl = document.getElementById('book-stages');
  var reviewsEl = document.getElementById('book-reviews');
  var outputEl = document.getElementById('book-output');
  var outFootEl = document.getElementById('book-out-foot');
  var countEl = document.getElementById('book-count');
  var downloadBtn = document.getElementById('book-download');

  if (!spiritEl || !runBtn) return;

  var manuscript = '';

  /* ---------- 1. 文稿上传 ---------- */

  function loadFile(file) {
    if (!file) return;
    if (!/\.(txt|md)$/i.test(file.name)) {
      fileNote.textContent = '只收 .txt / .md 文本文件，换一份试试';
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      manuscript = String(reader.result || '');
      var chars = manuscript.replace(/\s/g, '').length;
      fileNote.textContent = file.name + ' · 约 ' + chars + ' 字（点此更换）';
      dropEl.classList.add('has-file');
    };
    reader.onerror = function () {
      fileNote.textContent = '文稿读不出来，换一份试试';
    };
    reader.readAsText(file);
  }

  // 点击/键盘唤起文件选择
  dropEl.addEventListener('click', function () { fileEl.click(); });
  dropEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileEl.click();
    }
  });
  fileEl.addEventListener('change', function () {
    loadFile(fileEl.files && fileEl.files[0]);
  });

  // 拖入
  ['dragenter', 'dragover'].forEach(function (ev) {
    dropEl.addEventListener(ev, function (e) {
      e.preventDefault();
      dropEl.classList.add('is-over');
    });
  });
  ['dragleave', 'dragend', 'drop'].forEach(function (ev) {
    dropEl.addEventListener(ev, function (e) {
      e.preventDefault();
      dropEl.classList.remove('is-over');
    });
  });
  dropEl.addEventListener('drop', function (e) {
    var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  /* ---------- 2. 三校进度 ---------- */

  var STAGE_INDEX = { draft: 0, review: 1, final: 2 };

  function stageLi(stage) {
    return stagesEl.querySelector('li[data-stage="' + stage + '"]');
  }

  function resetStages() {
    stagesEl.removeAttribute('hidden');
    stagesEl.querySelectorAll('li').forEach(function (li) {
      li.classList.remove('is-active', 'is-done');
    });
    reviewsEl.textContent = '';
  }

  function onStage(stage, state) {
    var li = stageLi(stage);
    if (!li) return;

    if (state === 'start') {
      li.classList.add('is-active');
    } else if (state === 'done') {
      li.classList.remove('is-active');
      li.classList.add('is-done');
      var next = STAGE_INDEX[stage] + 1;
      var nextLi = stagesEl.querySelectorAll('li')[next];
      if (nextLi) nextLi.classList.add('is-active');
    }
  }

  var REVIEW_NAME = { dedup: '去重校', ai: '去AI味校', safe: '文辞合规校' };

  function onReview(key, text) {
    var li = document.createElement('li');
    li.setAttribute('data-review', key);
    var name = document.createElement('span');
    name.className = 'book-review-name';
    name.textContent = REVIEW_NAME[key] || key;
    var body = document.createElement('span');
    body.className = 'book-review-text';
    body.textContent = text;
    li.appendChild(name);
    li.appendChild(body);
    reviewsEl.appendChild(li);
  }

  /* ---------- 3. 呈作 ---------- */

  function show(text) {
    outputEl.textContent = text;
    outputEl.removeAttribute('hidden');
  }

  function ready(text, isFallback) {
    countEl.textContent = (isFallback ? '本地框架 · ' : '定稿 · ') +
                          text.replace(/\s/g, '').length + ' 字';
    outFootEl.removeAttribute('hidden');
    downloadBtn.disabled = false;
  }

  runBtn.addEventListener('click', function () {
    var spirit = spiritEl.value.trim();
    if (!spirit) {
      show('先写下作者的精神状态与写书内核。几句话就够——写不出，书还没有根。');
      spiritEl.focus();
      return;
    }

    runBtn.disabled = true;
    runBtn.textContent = '大儒正在著书…';
    if (awaitEl) awaitEl.setAttribute('hidden', '');
    resetStages();
    outputEl.textContent = '';
    outputEl.removeAttribute('hidden');
    outFootEl.setAttribute('hidden', '');
    downloadBtn.disabled = true;

    hengji.book(spirit, manuscript, {
      onStage: onStage,
      onReview: onReview,
      onChunk: function (full) {
        outputEl.textContent = full;
        outputEl.scrollTop = outputEl.scrollHeight;
      }
    }).then(function (book) {
      outputEl.textContent = book;
      outputEl.scrollTop = 0;
      var li = stageLi('final');
      if (li) { li.classList.remove('is-active'); li.classList.add('is-done'); }
      runBtn.textContent = '再呈一部';
      ready(book, false);
    }).catch(function () {
      // 大儒不在或管线中断：本地著书框架保底，草屋不假装有智能
      var skeleton = hengji.bookSkeleton(spirit);
      show('大儒今日不在，先给你一副著书框架。\n\n' + skeleton);
      stagesEl.setAttribute('hidden', '');
      runBtn.textContent = '再呈一部';
      ready(outputEl.textContent, true);
    }).then(function () {
      runBtn.disabled = false;
    });
  });

  /* ---------- 4. 下载书卷 ---------- */

  function bookName(text) {
    var m = text.match(/《([^》]{1,20})》/);
    if (m) return m[1].trim();
    m = text.match(/^#\s+(.{1,20})/m);
    if (m) return m[1].trim().replace(/[\\/:*?"<>|]/g, '');
    return '大儒呈作';
  }

  downloadBtn.addEventListener('click', function () {
    var text = outputEl.textContent;
    if (!text || downloadBtn.disabled) return;

    // BOM：让旧版 Windows 记事本也认得 UTF-8
    var blob = new Blob(['﻿', text], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = bookName(text) + '.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
})();
