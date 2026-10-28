/* ============================================================
   草屋 · 情感本写手 —— 成稿下载
   真 .docx（OOXML，标题 / 元信息 / 章题 / 正文样式分明）与 .md
   （frontmatter：主角姓名、主题、类型、风格）。
   零依赖：手写 ZIP（STORE 不压缩）＋ CRC32，Word / WPS 均可直接打开。
   只在访客点「下载」时于浏览器内生成，不落盘、不入库。
   ============================================================ */

window.EmotionDocx = (function () {
  'use strict';

  var CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
  function cnNum(n) { return CN[n] || String(n); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function slugify(text, fallback) {
    var s = String(text || '')
      .replace(/[\\/:*?"<>|\s、，。！？：；（）·—…]+/g, '-')
      .replace(/-+/g, '-').replace(/^-|-$/g, '');
    return s.slice(0, 30) || (fallback || '情感本');
  }

  /* ---------------- DOCX ---------------- */

  // 样式：Title 书名 / Meta 元信息 / Heading1 章题 / Body 正文。
  // 正文宋体小四、1.5 倍行距、首行缩进两字；章题黑体居中。
  function stylesXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:docDefaults><w:rPrDefault><w:rPr>'
      + '<w:rFonts w:ascii="Times New Roman" w:eastAsia="SimSun" w:hAnsi="Times New Roman"/>'
      + '<w:sz w:val="24"/><w:szCs w:val="24"/>'
      + '</w:rPr></w:rPrDefault></w:docDefaults>'
      + styleTitle() + styleMeta() + styleHeading() + styleBody()
      + '</w:styles>';
  }

  function styleTitle() {
    return '<w:style w:type="paragraph" w:styleId="BookTitle"><w:name w:val="Title"/>'
      + '<w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/></w:pPr>'
      + '<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="SimHei" w:hAnsi="Times New Roman"/>'
      + '<w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>';
  }

  function styleMeta() {
    return '<w:style w:type="paragraph" w:styleId="BookMeta"><w:name w:val="Subtitle"/>'
      + '<w:pPr><w:spacing w:after="60" w:line="300" w:lineRule="auto"/></w:pPr>'
      + '<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="FangSong" w:hAnsi="Times New Roman"/>'
      + '<w:color w:val="595959"/><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr></w:style>';
  }

  function styleHeading() {
    return '<w:style w:type="paragraph" w:styleId="BookHeading"><w:name w:val="heading 1"/>'
      + '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/>'
      + '<w:pPr><w:keepNext/><w:jc w:val="center"/>'
      + '<w:spacing w:before="360" w:after="200"/><w:outlineLvl w:val="0"/></w:pPr>'
      + '<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="SimHei" w:hAnsi="Times New Roman"/>'
      + '<w:b/><w:sz w:val="30"/><w:szCs w:val="30"/></w:rPr></w:style>';
  }

  function styleBody() {
    return '<w:style w:type="paragraph" w:styleId="BookBody"><w:name w:val="Normal"/>'
      + '<w:pPr><w:jc w:val="both"/><w:ind w:firstLineChars="200" w:firstLine="480"/>'
      + '<w:spacing w:line="360" w:lineRule="auto" w:after="0"/></w:pPr>'
      + '<w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="SimSun" w:hAnsi="Times New Roman"/>'
      + '<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>';
  }

  function para(text, styleId) {
    return '<w:p><w:pPr><w:pStyle w:val="' + styleId + '"/></w:pPr>'
      + '<w:r><w:t xml:space="preserve">' + esc(text) + '</w:t></w:r></w:p>';
  }

  function blankPara() {
    return '<w:p><w:pPr><w:pStyle w:val="BookMeta"/></w:pPr></w:p>';
  }

  function documentXml(ctx) {
    var m = ctx.meta;
    var parts = [];
    parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
    parts.push('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">');
    parts.push('<w:body>');

    parts.push(para('《' + m.title + '》', 'BookTitle'));
    parts.push(para('主角：' + (m.protagonist || '—'), 'BookMeta'));
    parts.push(para('类型：' + (m.genre || '—') + '　｜　主题：' + (m.theme || '—'), 'BookMeta'));
    parts.push(para('文风：' + (m.style || '—'), 'BookMeta'));
    parts.push(para('全' + ctx.chapters.length + '章 · 约 ' + ctx.totalChars + ' 字', 'BookMeta'));
    parts.push(blankPara());

    ctx.chapters.forEach(function (ch) {
      parts.push(para('第' + cnNum(ch.index) + '章　' + ch.title, 'BookHeading'));
      String(ch.prose || '').split(/\n{2,}/).map(function (s) {
        return s.replace(/\s*\n\s*/g, ' ').trim();
      }).filter(Boolean).forEach(function (p) {
        parts.push(para(p, 'BookBody'));
      });
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

  // files: [{name, bytes:Uint8Array}] → Blob（STORE 不压缩，Word 照开）
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
      local.setUint32(0, 0x04034b50, true);     // local file header signature
      local.setUint16(4, 20, true);            // version needed
      local.setUint16(6, 0x0800, true);        // bit 11: UTF-8 文件名
      local.setUint16(8, 0, true);             // compression: store
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);         // compressed size
      local.setUint32(22, size, true);         // uncompressed size
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);            // no extra field
      chunks.push(local.buffer, nameBytes, f.bytes);

      var dir = new DataView(new ArrayBuffer(46));
      dir.setUint32(0, 0x02014b50, true);      // central directory signature
      dir.setUint16(4, 20, true);              // version made by
      dir.setUint16(6, 20, true);              // version needed
      dir.setUint16(8, 0x0800, true);
      dir.setUint16(10, 0, true);
      dir.setUint16(12, dosTime, true);
      dir.setUint16(14, dosDate, true);
      dir.setUint32(16, crc, true);
      dir.setUint32(20, size, true);
      dir.setUint32(24, size, true);
      dir.setUint16(28, nameBytes.length, true);
      dir.setUint32(42, offset, true);         // local header offset
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
    // 值里出现冒号或 # 开头会破坏 YAML，统一加引号并转义引号
    return '"' + String(s == null ? '' : s).replace(/"/g, '\\"') + '"';
  }

  function buildMarkdown(ctx) {
    var m = ctx.meta;
    var L = [];
    L.push('---');
    L.push('主角: ' + yamlSafe(m.protagonist || ''));
    L.push('主题: ' + yamlSafe(m.theme || ''));
    L.push('类型: ' + yamlSafe(m.genre || ''));
    L.push('风格: ' + yamlSafe(m.style || ''));
    L.push('');
    L.push('共 ' + ctx.chapters.length + ' 章 · 约 ' + ctx.totalChars + ' 字');
    L.push('---');
    L.push('');
    L.push('# 《' + m.title + '》');
    L.push('');
    ctx.chapters.forEach(function (ch) {
      L.push('## 第' + cnNum(ch.index) + '章　' + ch.title);
      L.push('');
      L.push(String(ch.prose || '').trim());
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
    buildDocxBlob: buildDocxBlob,
    buildMarkdown: buildMarkdown,
    download: download
  };
})();
