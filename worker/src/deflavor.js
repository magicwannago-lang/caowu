// AI味检测器：自 emotion-scribe/app/lib/deflavor.mjs 移入，规则与「人类指纹」
// 提示词（prompts-emotion.js）一一对应：模型照规范写，这里照规范查。
// 纯本地确定性规则、零依赖；阈值如需调整，改本文件常量即可。

// 高频AI味词（出现在正文即记违规）
export const AI_TELL_WORDS = [
  '绽放', '诠释', '勾勒', '交织', '氤氲', '沉淀', '涌动', '悸动', '拉扯', '羁绊',
  '宿命感', '破碎感', '氛围感', '救赎', '双向奔赴', '感同身受', '五味杂陈', '百感交集',
  '心照不宣', '不约而同', '温柔了', '惊艳了', '治愈了', '赋能',
  '内心深处', '灵魂深处', '时光深处', '记忆深处', '岁月', '时光', '流年', '宿命',
  '深深地', '静静地', '久久地', '悄悄地', '渐渐地', '缓缓地', '无声地'
];

// 零容忍句式：出现即违规
const ZERO_PATTERNS = [
  { code: 'not-but', name: '「不是…而是…」句式', re: /不是[^。，；！？\n]{1,16}，?而是/g },
  { code: 'rather-than', name: '「与其说…不如说…」句式', re: /与其说[^。\n]{1,24}不如说/g },
  { code: 'someone-says', name: '「有人说 / 人们常说」开场', re: /(有人说|人们常说|人们总说|都说)/g },
  { code: 'as-if-telling', name: '「仿佛/像是在诉说」解释句', re: /(仿佛在|像是在)(诉说|告诉|提醒|告别|挽留)/g },
  { code: 'sublimation', name: '升华总结句（这大概就是…）', re: /这(大概|也许|或许|可能)?就是/g },
  { code: 'essay-transition', name: '议论文过渡语', re: /(不得不说|值得注意的是|值得一提的是|事实上|诚然|毫无疑问|由此可见|归根结底)/g },
  { code: 'essay-enum', name: '列举式过渡（首先/其次/总之）', re: /(首先|其次|再者|总之|综上)[，、]/g },
  { code: 'direct-emotion', name: '直陈情绪（我很难过/鼻子一酸…）', re: /(我很|我非常|我十分|心里一酸|鼻子一酸|眼眶湿润|眼眶一热|泪水在眼眶里|泪流满面|心如刀绞)/g }
];

// 计数容忍：每千字 perK 处，且绝对量不超过 abs（缺 abs 不设上限）
const COUNT_PATTERNS = [
  { code: 'however', name: '书面转折词「然而」', re: /然而/g, perK: 1 },
  { code: 'meanwhile', name: '「与此同时」', re: /与此同时/g, perK: 0.5 },
  { code: 'exclaim', name: '感叹号', re: /[!！]/g, perK: 3, abs: 3 },
  { code: 'ellipsis', name: '省略号', re: /……|…/g, perK: 2, abs: 3 },
  { code: 'dash', name: '破折号', re: /——/g, perK: 1.5, abs: 2 }
];

// 三连同构排比（「X的Y，X的Y，X的Y」）
const TRI_PARALLEL = /([一-龥]{1,4}的[一-龥]{1,6}，){2}[一-龥]{1,4}的[一-龥]{1,6}[，。；！？]/g;
// 比喻词
const SIMILE = /(像|好像|如同|仿佛|宛如|恍若|好似)/g;

function snippet(text, match) {
  const start = Math.max(0, match.index - 10);
  const end = Math.min(text.length, match.index + match[0].length + 10);
  return '…' + text.slice(start, end).replace(/\s+/g, '␣') + '…';
}

function countOf(text, word) {
  return text.split(word).length - 1;
}

/**
 * 分析一段文本的「AI味」。violations 按出现数排序。
 * 返回 { metrics, violations }；violations 元素：{ code, name, count, allowed?, samples }
 */
export function analyzeText(text, contract = {}, taboo = []) {
  const clean = String(text || '');
  const chars = clean.replace(/\s/g, '').length || 1;
  const paragraphs = clean.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const sentences = clean.split(/(?<=[。！？!?…；;])/).map((s) => s.trim()).filter(Boolean);
  const metrics = {
    chars,
    paragraphs: paragraphs.length,
    sentences: sentences.length,
    avgSentence: Math.round(chars / Math.max(1, sentences.length))
  };
  const violations = [];

  for (const p of ZERO_PATTERNS) {
    p.re.lastIndex = 0;
    const ms = [...clean.matchAll(p.re)];
    if (ms.length) violations.push({ code: p.code, name: p.name, count: ms.length, allowed: 0, samples: ms.slice(0, 3).map((m) => snippet(clean, m)) });
  }

  for (const p of COUNT_PATTERNS) {
    p.re.lastIndex = 0;
    const ms = [...clean.matchAll(p.re)];
    const allowed = Math.min(Math.ceil((p.perK * chars) / 1000), p.abs == null ? Infinity : p.abs);
    if (ms.length > allowed) {
      violations.push({ code: p.code, name: p.name, count: ms.length, allowed, samples: ms.slice(0, 3).map((m) => snippet(clean, m)) });
    }
  }

  // 高频AI味词
  const tellHits = [];
  for (const w of AI_TELL_WORDS) {
    const c = countOf(clean, w);
    if (c > 0) tellHits.push(w + '×' + c);
  }
  if (tellHits.length) violations.push({ code: 'ai-word', name: 'AI高频词', count: tellHits.length, allowed: 0, samples: tellHits.slice(0, 8) });

  // 契约回避词 + 用户禁忌词
  const banned = [...((contract && contract.vocabulary && contract.vocabulary.avoid) || []), ...(taboo || [])]
    .map((w) => String(w || '').trim()).filter(Boolean);
  for (const w of [...new Set(banned)]) {
    const c = countOf(clean, w);
    if (c > 0) violations.push({ code: 'banned-word', name: '禁忌词「' + w + '」', count: c, allowed: 0, samples: [] });
  }

  // 三连同构排比
  TRI_PARALLEL.lastIndex = 0;
  const tri = [...clean.matchAll(TRI_PARALLEL)];
  if (tri.length) violations.push({ code: 'parallel-triple', name: '三连同构排比', count: tri.length, allowed: 0, samples: tri.slice(0, 2).map((m) => snippet(clean, m)) });

  // 比喻密度：单段比喻词超过 2 处
  for (let i = 0; i < paragraphs.length; i++) {
    SIMILE.lastIndex = 0;
    const c = [...paragraphs[i].matchAll(SIMILE)].length;
    if (c > 2) {
      violations.push({ code: 'simile-density', name: '第' + (i + 1) + '段比喻过密（' + c + '处）', count: c, allowed: 2, samples: [] });
    }
  }

  // 超长句（>60 字，容忍 1 句）与超长段（>220 字）
  const longS = sentences.filter((s) => s.replace(/\s/g, '').length > 60);
  if (longS.length > 1) {
    violations.push({ code: 'long-sentence', name: '超长句（>60字）', count: longS.length, allowed: 1, samples: longS.slice(0, 2).map((s) => '…' + s.slice(0, 40) + '…') });
  }
  const longP = paragraphs.filter((p) => p.replace(/\s/g, '').length > 220);
  if (longP.length) {
    violations.push({ code: 'long-paragraph', name: '超长段（>220字）', count: longP.length, allowed: 0, samples: longP.slice(0, 2).map((p) => '…' + p.slice(0, 40) + '…') });
  }

  violations.sort((a, b) => b.count - a.count);
  return { metrics, violations };
}

export function formatViolations(violations) {
  return (violations || []).map((v) => v.name + '×' + v.count).join('；') || '无';
}
