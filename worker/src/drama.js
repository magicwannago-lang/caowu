// 短剧编剧：衡几第六件器物的后端管线。
// 无状态、不落盘：三 phase 由前端分请求驱动 ——
//   premise（JSON，企划）/ outline（JSON，分集大纲）/ episode（SSE，单集剧本）。
// episode 一次请求内：起草流式 → 不足 80% 扩写（至多两轮）→ 勾了润色则流式润色
// → 篇幅校验后定稿。成稿只随 done 事件下发，由浏览器下载，Worker 不存。
// 母本：用户上传的 drama-writer 本地 Node 应用（不入库）。

import {
  premiseSystem, premisePrompt,
  outlineSystem, outlinePrompt,
  scriptSystem, scriptPrompt,
  expandSystem, expandPrompt,
  POLISH_SYSTEM, polishPrompt
} from './prompts-drama.js';
import { dramaGenreIds, findDramaGenre, FREQ_LABEL } from './genres-drama.js';

const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

const JSON_MAXTOK = 4096;
const ROUND_MAXTOK = 12_000;

const PREMISE_TIMEOUT_MS = 90_000;
const OUTLINE_TIMEOUT_MS = 90_000;
const ROUND_TIMEOUT_MS = 110_000;

// 字数到目标后等句读再中断；此为最长等待（句中硬切的兜底）
const STOP_GRACE = 200;

const PHASES = ['premise', 'outline', 'episode'];

/* ---------------- 入站净化（开放接口，白名单 + 限长） ---------------- */

const asStr = (v, max = Infinity) => (typeof v === 'string' ? v.slice(0, max) : '');
const asNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const asArr = (v) => (Array.isArray(v) ? v : []);

const oneLine = (s, max) => asStr(s, max).replace(/\s*\n+\s*/g, '；').trim();

function sanitizeInput(raw) {
  const o = asObj(raw) || {};
  const clamp = (n, min, max, dflt) => {
    const v = Number(asNum(n));
    if (!Number.isFinite(v)) return dflt;
    return Math.min(max, Math.max(min, Math.round(v)));
  };
  const freq = o.freq === 'female' ? 'female' : 'male';
  const ids = dramaGenreIds(freq);
  const genre = ids.includes(o.genre) ? o.genre : ids[0];
  return {
    freq,
    genre,
    plot: asStr(o.plot, 2000).trim(),
    protagonist: oneLine(o.protagonist, 60),
    extra: oneLine(o.extra, 600),
    episodes: clamp(o.episodes, 1, 20, 5),
    wordsPerEpisode: clamp(o.wordsPerEpisode, 200, 5000, 800),
    polish: o.polish === false ? false : true
  };
}

function sanitizePremise(raw, input) {
  const p = asObj(raw);
  if (!p) return null;
  const title = asStr(p.title, 60).trim().replace(/[《》]/g, '');
  if (!title) return null;
  const characters = asArr(p.characters).map((c0) => {
    const c = asObj(c0);
    if (!c) return null;
    return {
      name: asStr(c.name, 20).trim(),
      role: asStr(c.role, 120).trim(),
      archetype: asStr(c.archetype, 40).trim(),
      arc: asStr(c.arc, 80).trim()
    };
  }).filter((c) => c && c.name).slice(0, 8);
  if (!characters.length) return null;
  return {
    title,
    logline: asStr(p.logline, 300).trim(),
    genre: asStr(p.genre, 20).trim() || findDramaGenre(input.freq, input.genre).name,
    freq: FREQ_LABEL[input.freq],
    centralConflict: asStr(p.centralConflict, 300).trim(),
    characters,
    emotionArc: asStr(p.emotionArc, 160).trim(),
    sellingPoints: asArr(p.sellingPoints)
      .map((x) => asStr(x, 40).trim()).filter(Boolean).slice(0, 6),
    twistCount: asStr(p.twistCount, 20).trim()
  };
}

function sanitizeEpisode(raw0, wordTarget, forcedIndex) {
  const e = asObj(raw0);
  if (!e) return null;
  const index = Math.min(20, Math.max(1, forcedIndex || Math.round(asNum(e.index) || 1)));
  // 至少要有 title/beat/plot 之一，模型给的空壳条目不要
  if (!asStr(e.title).trim() && !asStr(e.beat).trim() && !asStr(e.plot).trim()) return null;
  return {
    index,
    title: asStr(e.title, 40).trim() || ('第' + index + '集'),
    scene: asStr(e.scene, 120).trim(),
    beat: asStr(e.beat, 300).trim(),
    plot: asStr(e.plot, 300).trim(),
    conflict: asStr(e.conflict, 200).trim(),
    hook: asStr(e.hook, 160).trim(),
    emotionTarget: asStr(e.emotionTarget, 80).trim(),
    wordTarget
  };
}

/* ---------------- 入口 ---------------- */

export async function handleDrama(p, env) {
  const phase = PHASES.includes(p.phase) ? p.phase : null;
  if (!phase) return jsonError(400, '请求缺少合法的 phase');
  if (!env.ARK_API_KEY) return jsonError(500, phase, '后端未配置模型密钥');

  try {
    const input = sanitizeInput(p.input);
    if (!input.plot) return jsonError(400, phase, '先写下大概情节');

    if (phase === 'premise') {
      const premise = await buildPremise(input, env);
      return { status: 200, mode: 'json', body: { premise } };
    }

    const premise = sanitizePremise(p.premise, input);
    if (!premise) return jsonError(400, phase, '缺少企划');

    if (phase === 'outline') {
      const outline = await buildOutline(input, premise, env);
      return { status: 200, mode: 'json', body: { outline } };
    }

    // phase === 'episode'
    const episode = sanitizeEpisode(p.episode, input.wordsPerEpisode);
    if (!episode) return jsonError(400, phase, '缺少本集任务');
    const recap = asStr(p.recap, 800).trim();

    return {
      status: 200,
      mode: 'sse',
      body: streamEpisode({ input, premise, episode, recap, env })
    };
  } catch (err) {
    return jsonError(502, err.message || '短剧管线失败');
  }
}

function jsonError(status, phaseOrMsg, maybeMsg) {
  if (maybeMsg === undefined) return { status, mode: 'json', body: { error: phaseOrMsg } };
  return { status, mode: 'json', body: { error: maybeMsg, phase: phaseOrMsg } };
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
    { env, maxTokens: JSON_MAXTOK, temperature: 0.3, timeoutMs: PREMISE_TIMEOUT_MS, json: true }
  );
  return parseLoose(repaired.text);
}

/* ---------------- phase 1：企划 ---------------- */

async function buildPremise(input, env) {
  const raw = await arkJson(
    [
      { role: 'system', content: premiseSystem(input.freq) },
      { role: 'user', content: premisePrompt(input) }
    ],
    { env, maxTokens: JSON_MAXTOK, temperature: 0.7, timeoutMs: PREMISE_TIMEOUT_MS, json: true }
  );
  let parsed = parseLoose(raw.text);
  if (!parsed) parsed = await jsonRepair(raw.text,
    '{title,logline,genre,freq,centralConflict,characters:[{name,role,archetype,arc}],emotionArc,sellingPoints:[],twistCount}',
    env);

  const premise = sanitizePremise(parsed, input);
  if (!premise) throw new Error('企划不成体例');
  return premise;
}

/* ---------------- phase 2：分集大纲 ---------------- */

function validateOutline(o, input) {
  const x = asObj(o);
  if (!x) return null;
  const title = asStr(x.title, 60).trim().replace(/[《》]/g, '') || '无题短剧';
  const rawEpisodes = asArr(x.episodes);
  const episodes = [];
  for (const e0 of rawEpisodes) {
    // 序号强制重排，不信任模型给的 index；title 缺省由 sanitize 补
    const ep = sanitizeEpisode(e0, input.wordsPerEpisode, episodes.length + 1);
    if (!ep) continue;
    episodes.push(ep);
    if (episodes.length >= input.episodes) break;
  }
  if (!episodes.length) return null;
  return { title, episodes };
}

async function buildOutline(input, premise, env) {
  const raw = await arkJson(
    [
      { role: 'system', content: outlineSystem(input.freq) },
      { role: 'user', content: outlinePrompt(input, premise) }
    ],
    { env, maxTokens: JSON_MAXTOK, temperature: 0.85, timeoutMs: OUTLINE_TIMEOUT_MS, json: true }
  );
  let parsed = parseLoose(raw.text);
  if (!parsed) parsed = await jsonRepair(raw.text,
    '{title,episodes:[{index,title,scene,beat,plot,conflict,hook,emotionTarget,wordTarget}]}',
    env);

  const outline = validateOutline(parsed, input);
  if (!outline) throw new Error('大纲不成体例');
  return outline;
}

/* ---------------- phase 3：单集剧本 SSE ---------------- */

/** 解析剧本输出：SUMMARY: … / SCRIPT: … 标记格式；缺标记时全文当正文。 */
function parseScriptDraft(text) {
  const t = String(text || '').replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
  const m = t.match(/SUMMARY[:：][ \t]*([^\n]*)\n+SCRIPT[:：]?[ \t]*\n?([\s\S]*)/);
  if (m) return { summary: m[1].trim(), script: m[2].trim() };
  return { summary: '', script: t };
}

const cnCount = (s) => String(s || '').replace(/\s/g, '').length;

/** 取 SCRIPT 标记之后的正文（起草/扩写带 SUMMARY 头；润色无标记，全文即正文）。 */
function scriptAfterMark(acc) {
  const m = acc.match(/SCRIPT[:：]?[ \t]*\n?/);
  return m ? acc.slice(m.index + m[0].length) : acc;
}

function streamEpisode({ input, premise, episode, recap, env }) {
  const isFirst = episode.index === 1;
  const isLast = episode.index === input.episodes;

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
        send({ t: 'start', index: episode.index, target: episode.wordTarget });

        /* ── 起草：流式，带字数闸（到目标＋句读即中断上游） ── */
        const draft = await composeOnce({
          system: scriptSystem(input.freq),
          user: scriptPrompt({ input, premise, episode, recap, isFirst, isLast }),
          target: episode.wordTarget,
          temperature: 0.9,
          env, send, beat,
          stage: 'draft'
        });
        let parsed = parseScriptDraft(draft);
        let script = parsed.script;
        let summary = parsed.summary;
        if (!script) throw new Error('第' + episode.index + '集剧本为空');

        /* ── 字数硬校验：不足目标 80% 自动扩写，至多两轮 ── */
        const minChars = Math.round(episode.wordTarget * 0.8);
        for (let round = 1; cnCount(script) < minChars && round <= 2; round++) {
          send({ t: 'stage', stage: 'expand', round, chars: cnCount(script), target: episode.wordTarget });
          const expandedRaw = await composeOnce({
            system: expandSystem(input.freq),
            user: expandPrompt({ episode, target: episode.wordTarget, currentChars: cnCount(script), draft: script }),
            target: episode.wordTarget,
            temperature: 0.85,
            env, send, beat,
            stage: 'expand'
          });
          const expanded = parseScriptDraft(expandedRaw);
          if (expanded.script && cnCount(expanded.script) > cnCount(script)) {
            script = expanded.script;
            if (expanded.summary) summary = expanded.summary;
          } else {
            break; // 扩写无进展，放行
          }
        }

        /* ── 去AI味润色（勾了才做；篇幅不足 85% 则弃润色稿） ── */
        let finalScript = script;
        let polished = false;
        if (input.polish) {
          send({ t: 'stage', stage: 'polish' });
          const polishedText = (await composeOnce({
            system: POLISH_SYSTEM,
            user: polishPrompt({ draft: script }),
            target: null, // 润色不施字数闸：只许删改，长度由 0.85 校验把关
            temperature: 0.5,
            env, send, beat,
            stage: 'polish'
          })).replace(/^<<<DRAFT\n?/, '').replace(/\n?DRAFT>>>$/, '').trim();

          if (polishedText && polishedText.length > 50 &&
              cnCount(polishedText) >= Math.round(cnCount(script) * 0.85)) {
            finalScript = polishedText;
            polished = true;
          }
        }

        send({
          t: 'done',
          summary,
          script: finalScript,
          chars: cnCount(finalScript),
          target: episode.wordTarget,
          polished
        });
        closed = true;
        controller.close();
      } catch (err) {
        fail(err.message || '本集成稿失败');
      }
    }
  });
}

/**
 * 单次流式成稿调用：转发 chunk，带可选字数闸。
 * target 为 null 时不中断（润色）；否则正文到目标字数＋句读即 abort。
 * 字数只数 SCRIPT 之后的正文——SUMMARY 梗概行不算，否则系统性短稿。
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
            send({ t: 'progress', stage, chars: cnCount(scriptAfterMark(acc)), target });
          }
          if (target && !enough) {
            const body = scriptAfterMark(acc);
            const live = cnCount(body);
            const tail = body.replace(/\s+$/, '').slice(-1);
            const atPause = live >= target && /[。！？…」』）”.!?】]/.test(tail);
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
    const m = acc.match(/([\s\S]*SCRIPT[:：]?[ \t]*\n?)([\s\S]*)$/);
    if (m) {
      const clean = m[2].match(/[\s\S]*[。！？…」』）”.!?】]/);
      if (clean) acc = m[1] + clean[0].replace(/\s+$/, '');
    } else {
      const clean = acc.match(/[\s\S]*[。！？…」』）”.!?】]/);
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
