/* ============================================================
   草屋 · 大儒呈作（衡几第三件器物）
   接线：文稿上传（点击/拖入，就地读取）、SSE 三校进度、
   定稿预览、书卷下载。支持 .txt / .md / .docx / .doc；
   Word 解析库（mammoth、word-extractor）首次用到才加载。
   逻辑在 hengji.js（Hengji.book），大儒不在则退本地著书框架。
   不存任何东西、关掉页面即散。
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
  var stagesEl = document.getElementById('book-stages');
  var reviewsEl = document.getElementById('book-reviews');
  var outputEl = document.getElementById('book-output');
  var downloadBtn = document.getElementById('book-download');

  if (!spiritEl || !runBtn) return;

  var manuscript = '';

  /* ---------- 1. Word 解析库：首次上传前懒加载 ---------- */

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('解析库没加载进来')); };
      document.head.appendChild(s);
    });
  }

  // .docx：mammoth 一家即可
  var docxPromise = null;
  function loadDocxParser() {
    if (!docxPromise) docxPromise = loadScript('assets/vendor/mammoth.browser.min.js');
    return docxPromise;
  }

  // .doc：先 Buffer polyfill，再 process runtime，最后 word-extractor（顺序不可换）
  var docPromise = null;
  function loadDocParser() {
    if (!docPromise) {
      docPromise = loadScript('assets/vendor/buffer.browser.js')
        .then(function () { return loadScript('assets/vendor/word-runtime.js'); })
        .then(function () { return loadScript('assets/vendor/word-extractor.browser.js'); });
    }
    return docPromise;
  }

  /* ---------- 2. 文稿上传 ---------- */

  function readWord(file, ext) {
    var parserReady = ext === 'docx' ? loadDocxParser() : loadDocParser();

    return parserReady.then(function () {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () {
          var ab = r.result;

          if (ext === 'docx') {
            if (!window.mammoth) return reject(new Error('docx 解析库不可用'));
            window.mammoth.extractRawText({ arrayBuffer: ab })
              .then(function (res) { resolve(res.value || ''); })
              .catch(reject);
          } else {
            // 旧版 .doc：word-extractor + 预先注入的 Buffer/process
            if (!window.WordExtractor || !window.Buffer || !window.process) {
              return reject(new Error('doc 解析库不可用'));
            }
            var extractor = new window.WordExtractor();
            extractor.extract(window.Buffer.from(ab))
              .then(function (doc) { resolve(doc.getBody() || ''); })
              .catch(reject);
          }
        };
        r.onerror = function () { reject(new Error('文稿读不出来')); };
        r.readAsArrayBuffer(file);
      });
    });
  }

  function loadFile(file) {
    if (!file) return;

    var m = /\.([^.]+)$/.exec(file.name);
    var ext = m ? m[1].toLowerCase() : '';

    fileNote.textContent = '正在翻检「' + file.name + '」…';
    dropEl.classList.remove('has-file');

    var done = function (text) {
      manuscript = String(text || '');
      var chars = manuscript.replace(/\s/g, '').length;
      fileNote.textContent = file.name + ' · 约 ' + chars + ' 字（点此更换）';
      dropEl.classList.add('has-file');
    };

    if (ext === 'txt' || ext === 'md') {
      var reader = new FileReader();
      reader.onload = function () { done(reader.result); };
      reader.onerror = function () { fileNote.textContent = '文稿读不出来，换一份试试'; };
      reader.readAsText(file);
    } else if (ext === 'docx' || ext === 'doc') {
      readWord(file, ext).then(done).catch(function (err) {
        fileNote.textContent = err && err.message
          ? err.message
          : 'Word 文稿读不出来；.doc 旧文件可先另存为 .docx 再传';
      });
    } else {
      fileNote.textContent = '只收 .txt / .md / Word 文件，换一份试试';
    }
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

  /* ---------- 3. 三校进度 ---------- */

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
      var nextLi = stagesEl.querySelectorAll('li')[['draft', 'review', 'final'].indexOf(stage) + 1];
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

  /* ---------- 4. 呈作 ---------- */

  function show(text) {
    outputEl.textContent = text;
    outputEl.removeAttribute('hidden');
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
    downloadBtn.setAttribute('hidden', '');
    resetStages();
    outputEl.textContent = '';
    outputEl.removeAttribute('hidden');

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
      downloadBtn.removeAttribute('hidden');
    }).catch(function () {
      // 大儒不在或管线中断：本地著书框架保底，草屋不假装有智能
      show('大儒今日不在，先给你一副著书框架。\n\n' + hengji.bookSkeleton(spirit));
      stagesEl.setAttribute('hidden', '');
      runBtn.textContent = '再呈一部';
      downloadBtn.removeAttribute('hidden');
    }).then(function () {
      runBtn.disabled = false;
    });
  });

  /* ---------- 5. 下载书卷 ---------- */

  function bookName(text) {
    var m = text.match(/《([^》]{1,20})》/);
    if (m) return m[1].trim();
    m = text.match(/^#\s+(.{1,20})/m);
    if (m) return m[1].trim().replace(/[\\/:*?"<>|]/g, '');
    return '大儒呈作';
  }

  downloadBtn.addEventListener('click', function () {
    var text = outputEl.textContent;
    if (!text || downloadBtn.hasAttribute('hidden')) return;

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
