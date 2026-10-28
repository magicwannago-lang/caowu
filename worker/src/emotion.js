// 情感本写手：衡几第五件器物的后端管线。
// 无状态、不落盘：三 phase 由前端分请求驱动 ——
//   contract（JSON，风格契约）/ outline（JSON，大纲）/ chapter（SSE，单章成稿）。
// chapter 一次请求内：起草流式 → 不足 85% 扩写（至多两轮）→ 本地 AI 味检测 →
// 有违规则润色流式 → 校验后定稿。成稿只随 done 事件下发，由浏览器下载，Worker 不存。

import {
  CONTRACT_SYSTEM, contractPrompt,
  OUTLINE_SYSTEM, outlinePrompt,
  CHAPTER_SYSTEM, chapterPrompt,
  EXPAND_SYSTEM, expandPrompt,
  POLISH_SYSTEM, polishPrompt
} from './prompts-emotion.js';
import { analyzeText } from './deflavor.js';

const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

const JSON_MAXTOK = 4096;
const ROUND_MAXTOK = 8192;

const CONTRACT_TIMEOUT_MS = 90_000;
const OUTLINE_TIMEOUT_MS = 90_000;
const ROUND_TIMEOUT_MS = 110_000;

// 字数到目标后等句读再中断；此为最长等待（句中硬切的兜底）
const STOP_GRACE = 200;

const GENRES = ['情感故事', '剧本杀情感本', '电台读稿', '情感推文', '情书 · 回忆录'];
const PHASES = ['contract', 'outline', 'chapter'];

/* ---------------- 入站净化（开放接口，白名单 + 限长） ---------------- */

const asStr = (v, max = Infinity) => (typeof v === 'string' ? v.slice(0, max) : '');
const asNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const asArr = (v) => (Array.isArray(v) ? v : []);

const oneLine = (s) => asStr(s, 600).replace(/\s*\n+\s*/g, '；').trim();

function sanitizeInput(raw) {
  const o = asObj(raw) || {};
  const clamp = (n, min, max, dflt) => {
    const v = Number(asNum(n));
    if (!Number.isFinite(v)) return dflt;
    return Math.min(max, Math.max(min, Math.round(v)));
  };
  const taboo = (Array.isArray(o.taboo) ? o.taboo : asStr(o.taboo, 200).split(/[;；,，、\n]/))
    .map((s) => asStr(s, 20).trim())
    .filter(Boolean)
    .slice(0, 10);
  return {
    style: oneLine(o.style).slice(0, 500),
    requirements: oneLine(o.requirements).slice(0, 500),
    genre: GENRES.includes(o.genre) ? o.genre : '情感故事',
    theme: oneLine(o.theme).slice(0, 600),
    pov: asStr(o.pov, 40).trim(),
    mood: asStr(o.mood, 40).trim(),
    chapters: clamp(o.chapters, 1, 12, 3),
    wordsPerChapter: clamp(o.wordsPerChapter, 120, 3000, 600),
    taboo,
    deflavor: o.deflavor === false ? false : true
  };
}

function sanitizeContract(o) {
  const c = asObj(o);
  if (!c) return null;
  const s = asObj(c.sentence) || {};
  const v = asObj(c.vocabulary) || {};
  return {
    name: asStr(c.name, 40).trim(),
    narrativeVoice: asStr(c.narrativeVoice, 120).trim(),
    tense: asStr(c.tense, 60).trim(),
    sentence: {
      rhythm: asStr(s.rhythm, 80).trim(),
      avgLength: asStr(s.avgLength, 40).trim(),
      paragraph: asStr(s.paragraph, 80).trim()
    },
    vocabulary: {
      prefer: asArr(v.prefer).map((x) => asStr(x, 20).trim()).filter(Boolean).slice(0, 20),
      avoid: asArr(v.avoid).map((x) => asStr(x, 20).trim()).filter(Boolean).slice(0, 20)
    },
    imagery: asArr(c.imagery).map((x) => asStr(x, 20).trim()).filter(Boolean).slice(0, 12),
    emotionArc: asStr(c.emotionArc, 120).trim(),
    hardRules: asArr(c.hardRules).map((x) => asStr(x, 120).trim()).filter(Boolean).slice(0, 8),
    sampleSentence: asStr(c.sampleSentence, 200).trim()
  };
}

function sanitizeOutlineLight(o) {
  const x = asObj(o) || {};
  return {
    title: asStr(x.title, 60).trim(),
    logline: asStr(x.logline, 300).trim(),
    centralConflict: asStr(x.centralConflict, 300).trim(),
    resolution: asStr(x.resolution, 300).trim(),
    characters: asArr(x.characters).map((c) => {
      const co = asObj(c);
      return co ? { name: asStr(co.name, 20).trim(), role: asStr(co.role, 40).trim() } : null;
    }).filter(Boolean).slice(0, 8)
  };
}

function sanitizeChapter(o, wordTarget) {
  const c = asObj(o);
  if (!c) return null;
  const index = Math.min(12, Math.max(1, Math.round(asNum(c.index) || 1)));
  return {
    index,
    title: asStr(c.title, 40).trim() || ('第' + index + '章'),
    beat: asStr(c.beat, 300).trim(),
    plot: asStr(c.plot, 300).trim(),
    emotionTarget: asStr(c.emotionTarget, 80).trim(),
    hook: asStr(c.hook, 120).trim(),
    wordTarget
  };
}

/* ---------------- 入口 ---------------- */

export async function handleEmotion(p, env) {
  const phase = PHASES.includes(p.phase) ? p.phase : null;
  if (!phase) return jsonError(400, '请求缺少合法的 phase');
  if (!env.ARK_API_KEY) return jsonError(500, phase, '后端未配置模型密钥');

  try {
    const input = sanitizeInput(p.input);
    if (!input.style || !input.requirements) {
      return jsonError(400, phase, '先写下文笔风格与风格要求');
    }

    if (phase === 'contract') {
      const contract = await buildContract(input, env);
      return { status: 200, mode: 'json', body: { contract } };
    }

    const contract = sanitizeContract(p.contract);
    if (!contract || !contract.hardRules.length) {
      return jsonError(400, phase, '缺少风格契约');
    }

    if (phase === 'outline') {
      const outline = await buildOutline(input, contract, env);
      return { status: 200, mode: 'json', body: { outline } };
    }

    // phase === 'chapter'
    const outline = sanitizeOutlineLight(p.outline);
    const chapter = sanitizeChapter(p.chapter, input.wordsPerChapter);
    if (!chapter) return jsonError(400, phase, '缺少章节任务');
    const recap = asStr(p.recap, 800).trim();

    return {
      status: 200,
      mode: 'sse',
      body: streamChapter({ input, contract, outline, chapter, recap, env })
    };
  } catch (err) {
    return jsonError(502, phase, err.message || '情感本管线失败');
  }
}

function jsonError(status, phase, error) {
  return { status, mode: 'json', body: { error, phase } };
}

/* ---------------- JSON 容错解析（三级 + 一次修复） ---------------- */

function parseLoose(text) {
  const tries = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) tries.push(fence[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) tries.push(text.slice(first, last + 1));
  for (const t of tries) {
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object') return o;
    } catch { /* 下一种 */ }
  }
  return null;
}

async function jsonRepair(text, shape, env) {
  const repaired = await arkJson(
    [
      {
        role: 'system',
        content: '你是 JSON 修复器。下面给出一份不合规的文本与预期结构，请只输出修正后的 JSON 对象，不要代码围栏、不要解释。预期结构：' + shape
      },
      { role: 'user', content: '原文本：\n' + text.slice(0, 4000) + '\n\n请修复为合规 JSON。' }
    ],
    { env, maxTokens: JSON_MAXTOK, temperature: 0.3, timeoutMs: CONTRACT_TIMEOUT_MS, json: true }
  );
  return parseLoose(repaired.text);
}

/* ---------------- phase 1：风格契约 ---------------- */

async function buildContract(input, env) {
  const raw = await arkJson(
    [
      { role: 'system', content: CONTRACT_SYSTEM },
      { role: 'user', content: contractPrompt(input) }
    ],
    { env, maxTokens: JSON_MAXTOK, temperature: 0.6, timeoutMs: CONTRACT_TIMEOUT_MS, json: true }
  );
  let parsed = parseLoose(raw.text);
  if (!parsed) parsed = await jsonRepair(raw.text,
    '{name,narrativeVoice,tense,sentence:{rhythm,avgLength,paragraph},vocabulary:{prefer:[],avoid:[]},imagery:[],emotionArc,hardRules:[],sampleSentence}', env);

  const contract = sanitizeContract(parsed);
  if (!contract || !contract.hardRules.length || contract.imagery.length < 2) {
    throw new Error('风格契约不成体例');
  }
  // 用户禁忌词必进回避表
  for (const w of input.taboo) {
    if (!contract.vocabulary.avoid.includes(w)) contract.vocabulary.avoid.push(w);
  }
  return contract;
}

/* ---------------- phase 2：大纲 ---------------- */

function validateOutline(o, input) {
  const x = asObj(o);
  if (!x) return null;
  const title = asStr(x.title, 60).trim().replace(/[《》]/g, '');
  if (title.length < 1 || title.length > 40) return null;
  const rawChapters = asArr(x.chapters);
  const chapters = [];
  for (const c0 of rawChapters) {
    const c = asObj(c0);
    if (!c) continue;
    const t = asStr(c.title, 40).trim();
    if (!t) continue;
    chapters.push({
      index: chapters.length + 1,
      title: t,
      beat: asStr(c.beat, 300).trim(),
      plot: asStr(c.plot ?? c.beat, 300).trim(),
      emotionTarget: asStr(c.emotionTarget, 80).trim(),
      wordTarget: input.wordsPerChapter,
      hook: asStr(c.hook, 120).trim()
    });
    if (chapters.length >= input.chapters) break;
  }
  if (!chapters.length) return null;
  return {
    title,
    logline: asStr(x.logline, 300).trim(),
    centralConflict: asStr(x.centralConflict, 300).trim(),
    resolution: asStr(x.resolution, 300).trim(),
    characters: asArr(x.characters).map((c) => {
      const co = asObj(c);
      return co ? { name: asStr(co.name, 20).trim(), role: asStr(co.role, 40).trim() } : null;
    }).filter(Boolean).slice(0, 8),
    chapters
  };
}

async function buildOutline(input, contract, env) {
  const raw = await arkJson(
    [
      { role: 'system', content: OUTLINE_SYSTEM },
      { role: 'user', content: outlinePrompt(input, contract) }
    ],
    { env, maxTokens: JSON_MAXTOK, temperature: 0.8, timeoutMs: OUTLINE_TIMEOUT_MS, json: true }
  );
  let parsed = parseLoose(raw.text);
  if (!parsed) parsed = await jsonRepair(raw.text,
    '{title,logline,centralConflict,resolution,characters:[{name,role}],chapters:[{index,title,beat,plot,emotionTarget,hook}]}', env);

  const outline = validateOutline(parsed, input);
  if (!outline) throw new Error('大纲不成体例');
  return outline;
}

/* ---------------- phase 3：单章成稿 SSE ---------------- */

/** 解析章节输出：SUMMARY: … / PROSE: … 标记格式；缺标记时全文当正文。 */
function parseChapterDraft(text) {
  const t = String(text || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  const m = t.match(/SUMMARY[:：][ \t]*([^\n]*)\n+PROSE[:：][ \t]*\n?([\s\S]*)/);
  if (m) return { summary: m[1].trim(), prose: m[2].trim() };
  return { summary: '', prose: t };
}

const cnCount = (s) => String(s || '').replace(/\s/g, '').length;

function streamChapter({ input, contract, outline, chapter, recap, env }) {
  const isFirst = chapter.index === 1;
  const isLast = chapter.index === input.chapters;

  return new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;
      const send = (obj) => {
        if (closed) return;
        controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const fail = (msg) => {
        send({ t: 'error', error: msg });
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };
      const beat = () => setInterval(() => send({ t: 'ping' }), 12_000);

      try {
        send({ t: 'start', index: chapter.index, target: chapter.wordTarget });

        /* ── 起草：流式，带字数闸（到目标＋句读即中断上游） ── */
        const draft = await composeOnce({
          system: CHAPTER_SYSTEM,
          user: chapterPrompt({ input, contract, outline, chapter, recap, isFirst, isLast }),
          target: chapter.wordTarget,
          temperature: 0.9,
          env, send, beat,
          stage: 'draft'
        });
        let parsed = parseChapterDraft(draft);
        let prose = parsed.prose;
        let summary = parsed.summary;
        if (!prose) throw new Error('第' + chapter.index + '章正文为空');

        /* ── 字数硬校验：不足目标 85% 自动扩写，至多两轮 ── */
        const minChars = Math.round(chapter.wordTarget * 0.85);
        for (let round = 1; cnCount(prose) < minChars && round <= 2; round++) {
          send({ t: 'stage', stage: 'expand', round, chars: cnCount(prose), target: chapter.wordTarget });
          const expandedRaw = await composeOnce({
            system: EXPAND_SYSTEM,
            user: expandPrompt({ input, contract, chapter, target: chapter.wordTarget, currentChars: cnCount(prose), draft: prose }),
            target: chapter.wordTarget,
            temperature: 0.85,
            env, send, beat,
            stage: 'expand'
          });
          const expanded = parseChapterDraft(expandedRaw);
          if (expanded.prose && cnCount(expanded.prose) > cnCount(prose)) {
            prose = expanded.prose;
            if (expanded.summary) summary = expanded.summary;
          } else {
            break; // 扩写无进展，放行
          }
        }

        /* ── AI 味自查与润色 ── */
        let finalProse = prose;
        let polished = false;
        const before = analyzeText(prose, contract, input.taboo);
        let after = before;

        if (input.deflavor && before.violations.length) {
          send({ t: 'stage', stage: 'polish', violations: before.violations.length });
          const polishedText = (await composeOnce({
            system: POLISH_SYSTEM,
            user: polishPrompt({ contract, chapter, draft: prose, violations: before.violations }),
            target: null, // 润色不施字数闸：只许删改，长度由 0.9 校验把关
            temperature: 0.5,
            env, send, beat,
            stage: 'polish'
          })).replace(/^<<<DRAFT\n?/, '').replace(/\n?DRAFT>>>$/, '').trim();

          if (polishedText && polishedText.length > 20) {
            after = analyzeText(polishedText, contract, input.taboo);
            const lenOk = cnCount(polishedText) >= Math.round(cnCount(prose) * 0.9);
            if (after.violations.length <= before.violations.length && lenOk) {
              finalProse = polishedText;
              polished = true;
            } else {
              after = before; // 润色未改善或缩水，保留原稿
            }
          }
        } else if (input.deflavor) {
          after = before;
        }

        send({
          t: 'done',
          summary,
          prose: finalProse,
          chars: cnCount(finalProse),
          target: chapter.wordTarget,
          polished,
          before: { metrics: before.metrics, violations: input.deflavor ? before.violations : [] },
          after: { metrics: after.metrics, violations: input.deflavor ? after.violations : [] }
        });
        closed = true;
        controller.close();
      } catch (err) {
        fail(err.message || '本章成稿失败');
      }
    }
  });
}

/** 取 PROSE 标记之后的正文（起草/扩写带 SUMMARY 头；润色无标记，全文即正文）。 */
function proseAfterMark(acc) {
  const m = acc.match(/PROSE[:：][ \t]*\n?/);
  return m ? acc.slice(m.index + m[0].length) : acc;
}

/**
 * 单次流式成稿调用：转发 chunk，带可选字数闸。
 * target 为 null 时不中断（润色）；否则正文到目标字数＋句读即 abort。
 * 字数只数 PROSE 之后的正文——SUMMARY 梗概行不算，否则系统性短稿。
 */
async function composeOnce({ system, user, target, temperature, env, send, beat, stage }) {
  let acc = '';
  let enough = false;
  const abort = new AbortController();
  let lastProgress = 0;

  const timer = beat();
  try {
    await arkStream(
      [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      {
        env,
        maxTokens: ROUND_MAXTOK,
        temperature,
        timeoutMs: ROUND_TIMEOUT_MS,
        signal: abort.signal,
        onPiece: (piece) => {
          acc += piece;
          send({ t: 'chunk', text: piece });
          const now = Date.now();
          if (now - lastProgress > 600) {
            lastProgress = now;
            send({ t: 'progress', stage, chars: cnCount(proseAfterMark(acc)), target });
          }
          if (target && !enough) {
            const body = proseAfterMark(acc);
            const live = cnCount(body);
            const tail = body.replace(/\s+$/, '').slice(-1);
            const atPause = live >= target && /[。！？…」』）”.!?]/.test(tail);
            if (atPause || live >= target + STOP_GRACE) {
              enough = true;
              abort.abort();
            }
          }
        }
      }
    );
  } catch (err) {
    if (!(enough && err.name === 'AbortError')) throw err;
  } finally {
    clearInterval(timer);
  }

  // 字数闸 abort 是异步的：已缓冲残字可能漏进来。只截正文段到最后一个句读，
  // SUMMARY 头保持原样，不留悬尾。
  if (enough) {
    const m = acc.match(/([\s\S]*PROSE[:：][ \t]*\n?)([\s\S]*)$/);
    if (m) {
      const clean = m[2].match(/[\s\S]*[。！？…」』）”.!?]/);
      if (clean) acc = m[1] + clean[0].replace(/\s+$/, '');
    } else {
      const clean = acc.match(/[\s\S]*[。！？…」』）”.!?]/);
      if (clean) acc = clean[0].replace(/\s+$/, '');
    }
  }
  return acc;
}

/* ---------------- 方舟：非流式 ---------------- */

async function arkJson(messages, opts) {
  const { env, maxTokens, temperature, timeoutMs, json = false } = opts;
  const resp = await fetch(ARK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.ARK_API_KEY}`
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: env.MODEL,
      temperature,
      max_tokens: maxTokens,
      thinking: { type: 'disabled' },
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages
    })
  });

  if (!resp.ok) throw new Error(`模型应答异常（${resp.status}）`);

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('模型没有给出内容');
  return { text };
}

/* ---------------- 方舟：流式，逐块回调 ---------------- */

async function arkStream(messages, opts) {
  const { env, maxTokens, temperature, timeoutMs, signal, onPiece } = opts;

  const resp = await fetch(ARK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.ARK_API_KEY}`
    },
    signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), signal].filter(Boolean)),
    body: JSON.stringify({
      model: env.MODEL,
      temperature,
      max_tokens: maxTokens,
      thinking: { type: 'disabled' },
      stream: true,
      messages
    })
  });

  if (!resp.ok || !resp.body) throw new Error(`模型应答异常（${resp.status}）`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    buffer += decoder.decode(r.value, { stream: true });

    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      raw.split('\n').forEach((line) => {
        line = line.replace(/^data:/, '').trim();
        if (!line || line === '[DONE]') return;
        try {
          const piece = JSON.parse(line).choices?.[0]?.delta?.content;
          if (piece) onPiece(piece);
        } catch { /* 忽略心跳与非标准行 */ }
      });
    }
  }
}
