/* ============================================================
   草屋 · 短剧编剧 —— 成稿下载
   真 .docx（OOXML，剧名 / 元信息 / 分区题 / 集题 / 场景 / 台词样式分明）
   与 .md（frontmatter：频道、类型、主角、主线）。
   零依赖：手写 ZIP（STORE 不压缩）＋ CRC32，Word / WPS 均可直接打开。
   只在访客点「下载」时于浏览器内生成，不落盘、不入库。
   ============================================================ */

window.DramaDocx = (function () {
  'use strict';

  var CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
            '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十'];
  function cnNum(n) { return CN[n] || String(n); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function slugify(text, fallback) {
    var s = String(text || '')
      .replace(/[\\/:*?"<>|\s、，。！？：；（）·—…《》]+/g, '-')
      .replace(/-+/g, '-').replace(/^-|-$/g, '');
    return s.slice(0, 30) || (fallback || '短剧');
  }

  /* ---------------- 剧本行分类（与 Worker 提示词格式规范同源） ---------------- */

  // 一行 → { kind, speaker?, text, run2? }
  // kind: scene | eptitle | narration | action | speaker | normal | blank
  function classifyLine(rawLine) {
    var line = String(rawLine || '').trim();
    if (!line) return { kind: 'blank' };
    if (/^【[^】]*】/.test(line)) return { kind: 'scene', text: line };
    if (/^第[\d一二三四五六七八九十]+集\s/.test(line)) return { kind: 'eptitle', text: line };
    if (/^旁白[：:]/.test(line)) {
      return { kind: 'narration', text: line.replace(/^旁白[：:]/, '').trim() };
    }
    if (/^[（(].*[)）]$/.test(line)) return { kind: 'action', text: line };
    // 角色名（可带简短情绪提示，如：苏晴（声颤）：……）16 字以内、不含句读
    var m = line.match(/^([^：:。！？\n]{1,16})[：:]([\s\S]*)$/);
    if (m) return { kind: 'speaker', speaker: m[1] + '：', text: m[2].trim() };
    return { kind: 'normal', text: line };
  }

  /* ---------------- DOCX 样式（宋体正文 / 黑体题 / 仿宋眉注；灰青、浅赭点色） ---------------- */

  function stylesXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:docDefaults><w:rPrDefault><w:rPr>'
      + '<w:rFonts w:ascii="Times New Roman" w:eastAsia="SimSun" w:hAnsi="Times New Roman"/>'
      + '<w:sz w:val="24"/><w:szCs w:val="24"/>'
      + '</w:rPr></w:rPrDefault>'
      + '<w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="340" w:lineRule="auto"/></w:pPr></w:pPrDefault>'
      + '</w:docDefaults>'
      + [
        styleTitle(), styleMeta(), styleSection(),
        styleCharacter(), styleOutline(),
        styleEpTitle(), styleScene(),
        styleSpeaker(), styleDialogue(), styleNarration(), styleAction(), styleBlank()
      ].join('')
      + '</w:styles>';
  }

  function styleTitle() {
    return '<w:style w:type="paragraph" w:styleId="DramaTitle"><w:name w:val="Title"/>'
      + '<w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="200"/></w:pPr>'
      + '<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="SimHei" w:hAnsi="Times New Roman"/>'
      + '<w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>';
  }
  function styleMeta() {
    return '<w:style w:type="paragraph" w:styleId="DramaMeta"><w:name w:val="Subtitle"/>'
      + '<w:pPr><w:spacing w:after="50" w:line="300" w:lineRule="auto"/></w:pPr>'
      + '<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="FangSong" w:hAnsi="Times New Roman"/>'
      + '<w:color w:val="595959"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>';
  }
  function styleSection() {
    return '<w:style w:type="paragraph" w:styleId="DramaSection"><w:name w:val="heading 1"/>'
      + '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/>'
      + '<w:pPr><w:keepNext/><w:spacing w:before="360" w:after="140"/>'
      + '<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="2" w:color="D5CCBC"/></w:pBdr>'
      + '<w:outlineLvl w:val="0"/></w:pPr>'
      + '<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="SimHei" w:hAnsi="Times New Roman"/>'
      + '<w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>';
  }
  function styleCharacter() {
    return '<w:style w:type="paragraph" w:styleId="DramaCharacter"><w:name w:val="Character"/>'
      + '<w:pPr><w:spacing w:after="50" w:line="320" w:lineRule="auto"/>'
      + '<w:ind w:left="240"/></w:pPr>'
      + '<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="SimSun" w:hAnsi="Times New Roman"/>'
      + '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>';
  }
  function styleOutline() {
    return '<w:style w:type="paragraph" w:styleId="DramaOutline"><w:name w:val="Outline"/>'
      + '<w:pPr><w:spacing w:after="50" w:line="320" w:lineRule="auto"/>'
      + '<w:ind w:left="240"/></w:pPr>'
      + '<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="SimSun" w:hAnsi="Times New Roman"/>'
      + '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>';
  }
  function styleEpTitle() {
    return '<w:style w:type="paragraph" w:styleId="DramaEpTitle"><w:name w:val="Episode Title"/>'
      + '<w:pPr><w:keepNext/><w:spacing w:before="360" w:after="160"/></w:pPr>'
      + '<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="SimHei" w:hAnsi="Times New Roman"/>'
      + '<w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>';
  }
  function styleScene() {
    // 场景：灰青字，淡牙底色一格
    return '<w:style w:type="paragraph" w:styleId="DramaScene"><w:name w:val="Scene"/>'
      + '<w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/>'
      + '<w:shd w:val="clear" w:color="auto" w:fill="EFE9DC"/></w:pPr>'
      + '<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="SimHei" w:hAnsi="Times New Roman"/>'
      + '<w:b/><w:color w:val="35544F"/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style>';
  }
  function styleSpeaker() {
    // 角色名：浅赭加粗
    return '<w:style w:type="paragraph" w:styleId="DramaSpeaker"><w:name w:val="Speaker"/>'
      + '<w:pPr><w:spacing w:after="30" w:line="340" w:lineRule="auto"/>'
      + '<w:ind w:left="420" w:hanging="420"/></w:pPr>'
      + '<w:rPr><w:b/><w:color w:val="8A5433"/></w:rPr></w:style>';
  }
  function styleDialogue() {
    return '<w:style w:type="paragraph" w:styleId="DramaDialogue"><w:name w:val="Dialogue"/>'
      + '<w:pPr><w:spacing w:after="30" w:line="340" w:lineRule="auto"/>'
      + '<w:ind w:left="420" w:hanging="420"/></w:pPr><w:rPr/></w:style>';
  }
  function styleNarration() {
    return '<w:style w:type="paragraph" w:styleId="DramaNarration"><w:name w:val="Narration"/>'
      + '<w:pPr><w:spacing w:after="40" w:line="340" w:lineRule="auto"/>'
      + '<w:ind w:left="420"/></w:pPr>'
      + '<w:rPr><w:i/><w:color w:val="574C41"/></w:rPr></w:style>';
  }
  function styleAction() {
    return '<w:style w:type="paragraph" w:styleId="DramaAction"><w:name w:val="Action"/>'
      + '<w:pPr><w:spacing w:after="40" w:line="340" w:lineRule="auto"/>'
      + '<w:ind w:left="200"/></w:pPr>'
      + '<w:rPr><w:i/><w:color w:val="6A6055"/></w:rPr></w:style>';
  }
  function styleBlank() {
    return '<w:style w:type="paragraph" w:styleId="DramaBlank"><w:name w:val="Drama Blank"/>'
      + '<w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>';
  }

  function para(text, styleId) {
    return '<w:p><w:pPr><w:pStyle w:val="' + styleId + '"/></w:pPr>'
      + '<w:r><w:t xml:space="preserve">' + esc(text) + '</w:t></w:r></w:p>';
  }
  function blankPara() { return '<w:p><w:pPr><w:pStyle w:val="DramaBlank"/></w:pPr></w:p>'; }

  // 角色名＋台词分两 run，名分挂 DramaSpeaker、台词挂 DramaDialogue
  function dialoguePara(speaker, text) {
    return '<w:p><w:pPr><w:pStyle w:val="DramaSpeaker"/></w:pPr>'
      + '<w:r><w:t xml:space="preserve">' + esc(speaker) + '</w:t></w:r>'
      + '<w:r><w:rPr><w:color w:val="362D24"/><w:b w:val="0"/></w:rPr>'
      + '<w:t xml:space="preserve">' + esc(text) + '</w:t></w:r></w:p>';
  }

  function scriptParas(script) {
    var out = [];
    String(script || '').split('\n').forEach(function (rawLine) {
      var c = classifyLine(rawLine);
      if (c.kind === 'blank') { out.push(blankPara()); return; }
      if (c.kind === 'eptitle') return; // 集题由我们统一生成，跳过模型重复行
      if (c.kind === 'scene') { out.push(para(c.text, 'DramaScene')); return; }
      if (c.kind === 'action') { out.push(para(c.text, 'DramaAction')); return; }
      if (c.kind === 'narration') {
        out.push(para('旁白：' + c.text, 'DramaNarration'));
        return;
      }
      if (c.kind === 'speaker') { out.push(dialoguePara(c.speaker, c.text)); return; }
      out.push(para(c.text, 'DramaDialogue'));
    });
    return out.join('');
  }

  function documentXml(ctx) {
    var p = ctx.premise || {};
    var input = ctx.input || {};
    var episodes = ctx.episodes || [];
    var characters = p.characters || [];
    var parts = [];

    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    parts.push('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">');
    parts.push('<w:body>');

    parts.push(para('《' + (p.title || '无题短剧') + '》', 'DramaTitle'));
    parts.push(para((p.freq || input.freqLabel || '短剧') + '·' + (p.genre || input.genreLabel || '')
      + '　｜　共 ' + episodes.length + ' 集 · 每集约 ' + (input.wordsPerEpisode || '—')
      + ' 字 · 全文约 ' + (ctx.totalChars || 0) + ' 字', 'DramaMeta'));
    if (p.logline) parts.push(para('梗概：' + p.logline, 'DramaMeta'));
    if (p.centralConflict) parts.push(para('主线冲突：' + p.centralConflict, 'DramaMeta'));
    if (p.emotionArc) parts.push(para('节奏：' + p.emotionArc, 'DramaMeta'));
    parts.push(blankPara());

    if (characters.length) {
      parts.push(para('人物表', 'DramaSection'));
      characters.forEach(function (c) {
        var tail = (c.role || '—') + (c.archetype ? '（' + c.archetype + '）' : '');
        if (c.arc) tail += '；弧光：' + c.arc;
        parts.push('<w:p><w:pPr><w:pStyle w:val="DramaCharacter"/></w:pPr>'
          + '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">' + esc(c.name || '—') + '　</w:t></w:r>'
          + '<w:r><w:t xml:space="preserve">' + esc(tail) + '</w:t></w:r></w:p>');
      });
    }

    if (episodes.length) {
      parts.push(para('分集大纲', 'DramaSection'));
      episodes.forEach(function (e) {
        var line = '第' + cnNum(e.index) + '集 ' + (e.title || '')
          + '　— ' + (e.beat || e.summary || '');
        if (e.hook && e.index < episodes.length) line += '（钩子：' + e.hook + '）';
        parts.push(para(line, 'DramaOutline'));
      });
    }

    parts.push(para('剧本正文', 'DramaSection'));
    episodes.forEach(function (e) {
      parts.push(para('第' + cnNum(e.index) + '集　' + (e.title || ''), 'DramaEpTitle'));
      parts.push(scriptParas(e.script));
      parts.push(blankPara());
    });

    parts.push('<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
      + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" '
      + 'w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>');
    parts.push('</w:body></w:document>');
    return parts.join('');
  }

  function contentTypesXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" '
      + 'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '<Override PartName="/word/styles.xml" '
      + 'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
      + '</Types>';
  }
  function rootRelsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" '
      + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
      + 'Target="word/document.xml"/></Relationships>';
  }
  function docRelsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" '
      + 'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
      + 'Target="styles.xml"/></Relationships>';
  }

  /* ---------------- ZIP（STORE） ---------------- */

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function strBytes(s) { return new TextEncoder().encode(s); }

  function zipBlob(files) {
    var chunks = [];
    var central = [];
    var offset = 0;
    var now = new Date();
    var dosTime = ((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | ((now.getSeconds() / 2) & 31);
    var dosDate = (((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31);

    files.forEach(function (f) {
      var nameBytes = strBytes(f.name);
      var crc = crc32(f.bytes);
      var size = f.bytes.length;

      var local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // UTF-8 文件名
      local.setUint16(8, 0, true);      // store
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      chunks.push(local.buffer, nameBytes, f.bytes);

      var dir = new DataView(new ArrayBuffer(46));
      dir.setUint32(0, 0x02014b50, true);
      dir.setUint16(4, 20, true);
      dir.setUint16(6, 20, true);
      dir.setUint16(8, 0x0800, true);
      dir.setUint16(10, 0, true);
      dir.setUint16(12, dosTime, true);
      dir.setUint16(14, dosDate, true);
      dir.setUint32(16, crc, true);
      dir.setUint32(20, size, true);
      dir.setUint32(24, size, true);
      dir.setUint16(28, nameBytes.length, true);
      dir.setUint32(42, offset, true);
      central.push({ head: dir.buffer, name: nameBytes });

      offset += 30 + nameBytes.length + size;
    });

    var centralSize = 0;
    central.forEach(function (c) {
      chunks.push(c.head, c.name);
      centralSize += 46 + c.name.length;
    });

    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    chunks.push(end.buffer);

    return new Blob(chunks, {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
  }

  function buildDocxBlob(ctx) {
    var files = [
      { name: '[Content_Types].xml', bytes: strBytes(contentTypesXml()) },
      { name: '_rels/.rels', bytes: strBytes(rootRelsXml()) },
      { name: 'word/_rels/document.xml.rels', bytes: strBytes(docRelsXml()) },
      { name: 'word/styles.xml', bytes: strBytes(stylesXml()) },
      { name: 'word/document.xml', bytes: strBytes(documentXml(ctx)) }
    ];
    return zipBlob(files);
  }

  /* ---------------- Markdown ---------------- */

  function yamlSafe(s) {
    return '"' + String(s == null ? '' : s).replace(/"/g, '\\"') + '"';
  }

  function buildMarkdown(ctx) {
    var p = ctx.premise || {};
    var input = ctx.input || {};
    var episodes = ctx.episodes || [];
    var lead = (p.characters || [])[0];
    var L = [];
    L.push('---');
    L.push('频道: ' + yamlSafe(p.freq || input.freqLabel || ''));
    L.push('类型: ' + yamlSafe(p.genre || input.genreLabel || ''));
    L.push('主角: ' + yamlSafe(lead ? lead.name : ''));
    L.push('主线: ' + yamlSafe(p.logline || p.centralConflict || ''));
    L.push('');
    L.push('共 ' + episodes.length + ' 集 · 每集约 ' + (input.wordsPerEpisode || '—')
      + ' 字 · 全文约 ' + (ctx.totalChars || 0) + ' 字');
    L.push('---');
    L.push('');
    L.push('# 《' + (p.title || '无题短剧') + '》');
    L.push('');
    L.push('> ' + (p.freq || '') + '·' + (p.genre || '')
      + '｜共 ' + episodes.length + ' 集 · 全文约 ' + (ctx.totalChars || 0) + ' 字');
    if (p.logline) L.push('> **梗概**：' + p.logline);
    if (p.centralConflict) L.push('> **主线冲突**：' + p.centralConflict);
    L.push('');

    if ((p.characters || []).length) {
      L.push('## 人物表');
      L.push('');
      L.push('| 角色 | 身份与性格 | 原型 |');
      L.push('| --- | --- | --- |');
      p.characters.forEach(function (c) {
        L.push('| **' + (c.name || '—') + '** | ' + (c.role || '—')
          + ' | ' + (c.archetype || '—') + ' |');
      });
      L.push('');
    }

    L.push('## 分集大纲');
    L.push('');
    episodes.forEach(function (e) {
      L.push('**第' + cnNum(e.index) + '集 ' + (e.title || '') + '** — '
        + (e.beat || e.summary || ''));
      if (e.hook && e.index < episodes.length) L.push('  - 钩子：' + e.hook);
    });
    L.push('');
    L.push('---');
    L.push('');

    episodes.forEach(function (e) {
      L.push('## 第' + cnNum(e.index) + '集　' + (e.title || ''));
      L.push('');
      L.push(String(e.script || '').trim());
      L.push('');
      L.push('---');
      L.push('');
    });
    return L.join('\n');
  }

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  return {
    slugify: slugify,
    classifyLine: classifyLine,
    buildDocxBlob: buildDocxBlob,
    buildMarkdown: buildMarkdown,
    download: download
  };
})();
