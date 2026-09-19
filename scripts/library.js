/* ============================================================
   草屋 · 曲库
   页面从 assets/audio/ 读曲目，不写死文件名。

   浏览器出于安全，不把目录列表交给网页；GitHub Pages 也不会
   自动列目录。所以「读目录」这一步落在构建期的 scripts/gen-manifest.py：
   它扫一遍 assets/audio/ 与 assets/img/，生成 assets/manifest.json，
   网页再读那个清单。上传完音频跑一次脚本即可。

   三级取材，逐级退让：
     1. assets/manifest.json   ← 正式清单（推荐）
     2. assets/audio/ 列目录   ← 本地 python -m http.server 时可用
     3. 内置默认清单           ← 什么都读不到时的兜底，界面不空着
   ============================================================ */

window.Library = (function () {
  'use strict';

  var MANIFEST = 'assets/manifest.json';

  /* 兜底：清单读不到时，至少让界面知道该去哪儿放文件。
     place:true 表示这只是个「位置」，不是真曲目。 */
  var FALLBACK = {
    audio: [{ file: '', title: '', place: true }],
    img: []
  };

  /* ---------- 工具 ---------- */

  function empty() {
    // 空曲库也是合格的答案：库里确实还没东西，不该再猜别处
    return { audio: [], img: [], source: 'empty' };
  }

  function parseList(text) {
    var out = [];
    var re = /href="([^"]+)"/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      var href = m[1];
      var name = href.split('/').pop();
      if (!name || name.charAt(0) === '.' || name.charAt(0) === '?') continue;
      if (!/\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i.test(name)) continue;
      out.push(name);
    }
    return out;
  }

  // 「雨落草檐.mp3」→「雨落草檐」；「02-rain-in-the-hut.mp3」→「rain in the hut」
  function titleOf(file) {
    var base = file.replace(/\.[^.]+$/, '');
    base = base.replace(/^\d+[\s._-]+/, '');
    base = base.replace(/[_-]+/g, ' ');
    return base.trim() || file;
  }

  function pathOf(item, dir) {
    if (item.path) return item.path;
    if (!item.file) return '';
    return dir + item.file;
  }

  function normalizeAudio(items) {
    return items.map(function (it) {
      var f = typeof it === 'string' ? { file: it } : (it || {});
      return {
        file: f.file || '',
        title: f.title || (f.file ? titleOf(f.file) : ''),
        sub: f.sub || '',
        src: pathOf(f, 'assets/audio/'),
        place: !!f.place
      };
    });
  }

  function normalizeImg(items) {
    return items.map(function (it) {
      var f = typeof it === 'string' ? { file: it } : (it || {});
      return {
        file: f.file || '',
        src: f.path || (f.file ? 'assets/img/' + f.file : ''),
        title: f.title || '',
        note: f.note || '',
        alt: f.alt || f.title || '',
        wide: !!f.wide,
        tall: !!f.tall,
        scale: !!f.scale,
        ratio: f.ratio || ''
      };
    });
  }

  /* ---------- 取数 ---------- */

  function fetchJSON(url) {
    return fetch(url, { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function fetchText(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  }

  // 退让二：本地起服务时，目录列表页就是一份现成的清单
  function fromDirectory() {
    return fetchText('assets/audio/')
      .then(parseList)
      .then(function (files) {
        if (!files.length) throw new Error('empty');
        return { audio: normalizeAudio(files), img: [] };
      });
  }

  function load() {
    // 一级：正式清单。清单在（哪怕它写着「空」）就以它为准——
    // 清单空是「还没上传」，不该再猜。
    return fetchJSON(MANIFEST)
      .then(function (data) {
        return {
          audio: normalizeAudio(data.audio || data.tracks || []),
          img: normalizeImg(data.img || data.images || []),
          source: 'manifest'
        };
      })
      .catch(function () {
        // 二级：清单读不到（还没生成 / 服务器不给），退回目录列表
        return fromDirectory()
          .then(function (data) {
            data.source = 'directory';
            return data;
          })
          .catch(function () {
            // 三级：什么都读不到，用内置的「位置」占位，界面不空着
            return {
              audio: normalizeAudio(canonical(FALLBACK.audio)),
              img: [],
              source: 'fallback'
            };
          });
      });
  }

  function canonical(items) {
    return items.map(function (it) {
      return { file: it.file, title: it.title, sub: it.sub, place: it.place };
    });
  }

  return { load: load, titleOf: titleOf, empty: empty };
})();
