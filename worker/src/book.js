// 大儒呈作：衡几第三件器物的后端管线。
// 整路 SSE：起草 → 三校并行批阅 → 据意见重新定稿（流式）。
// 事件形如 data: {"t":"stage", ...}，解析在前端 scripts/book.js。

import {
  SCHOLAR_DRAFT_PROMPT,
  SCHOLAR_FINAL_PROMPT,
  REVIEW_DEDUP_PROMPT,
  REVIEW_AI_PROMPT,
  REVIEW_SAFE_PROMPT
} from './prompt-book.js';

const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

const SPIRIT_MAX = 4000;
const MANUSCRIPT_MAX = 20000;

const DRAFT_TIMEOUT_MS = 120_000;
const REVIEW_TIMEOUT_MS = 80_000;
const FINAL_TIMEOUT_MS = 220_000;

export async function handleBook(data, env) {
  const spirit = String(data.brief || '').trim().slice(0, SPIRIT_MAX);
  const manuscript = String(data.manuscript || '').slice(0, MANUSCRIPT_MAX);

  if (!spirit) {
    return { status: 400, body: { error: '先写下作者精神状态与写书内核' } };
  }
  if (!env.ARK_API_KEY) {
    return { status: 500, body: { error: '后端未配置模型密钥' } };
  }

  const today = new Date().toISOString().slice(0, 10);

  const body = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;

      function send(obj) {
        if (closed) return;
        controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      }
      function fail(msg) {
        send({ t: 'error', error: msg });
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }

      // 管线中途任何一步炸了都如实报给纸面，由前端退本地框架
      try {
        /* 1. 大儒起草 */
        send({ t: 'stage', stage: 'draft', state: 'start' });

        const draftUser =
          `今天是 ${today}。\n\n` +
          `门生自述（精神状态 · 写书内核）：\n${spirit}\n\n` +
          (manuscript.trim()
            ? `门生附来的文稿（部分正文与框架）：\n${manuscript}`
            : '（门生未附文稿，请依其内核独立成书。）');

        const draft = await arkJson(
          [
            { role: 'system', content: SCHOLAR_DRAFT_PROMPT },
            { role: 'user', content: draftUser }
          ],
          { env, maxTokens: 6144, temperature: 0.85, timeoutMs: DRAFT_TIMEOUT_MS }
        );
        send({ t: 'stage', stage: 'draft', state: 'done' });

        /* 2. 三名校书并行批阅 */
        send({ t: 'stage', stage: 'review', state: 'start' });

        const reviewers = [
          { key: 'dedup', prompt: REVIEW_DEDUP_PROMPT },
          { key: 'ai', prompt: REVIEW_AI_PROMPT },
          { key: 'safe', prompt: REVIEW_SAFE_PROMPT }
        ];

        const reviews = await Promise.all(
          reviewers.map((r) =>
            arkJson(
              [
                { role: 'system', content: r.prompt },
                {
                  role: 'user',
                  content:
                    `门生自述：\n${spirit}\n\n` +
                    (manuscript.trim() ? `门生原附文稿：\n${manuscript}\n\n` : '') +
                    `初稿全文：\n${draft}`
                }
              ],
              { env, maxTokens: 1200, temperature: 0.2, timeoutMs: REVIEW_TIMEOUT_MS }
            )
              .then((text) => {
                send({ t: 'review', key: r.key, text });
                return { key: r.key, text };
              })
              .catch(() => {
                // 一校失约不连累全管线：记一笔空意见
                send({ t: 'review', key: r.key, text: '（该校书今日失约，无意见）' });
                return { key: r.key, text: '' };
              })
          )
        );
        send({ t: 'stage', stage: 'review', state: 'done' });

        /* 3. 大儒据三校意见重新定稿，流式 */
        send({ t: 'stage', stage: 'final', state: 'start' });

        const reviewBlock = reviews
          .map((r) => {
            const name = { dedup: '去重校', ai: '去AI味校', safe: '文辞合规校' }[r.key];
            return `【${name}】\n${r.text || '无'}`;
          })
          .join('\n\n');

        const finalUser =
          `今天是 ${today}。\n\n` +
          `门生自述（精神状态 · 写书内核）：\n${spirit}\n\n` +
          (manuscript.trim() ? `门生原附文稿：\n${manuscript}\n\n` : '') +
          `初稿全文：\n${draft}\n\n` +
          `三校批阅意见：\n${reviewBlock}\n\n` +
          `请据意见重新成书定稿。`;

        let got = '';
        await arkStream(
          [
            { role: 'system', content: SCHOLAR_FINAL_PROMPT },
            { role: 'user', content: finalUser }
          ],
          {
            env,
            maxTokens: 6144,
            temperature: 0.8,
            timeoutMs: FINAL_TIMEOUT_MS,
            onPiece(piece) {
              got += piece;
              send({ t: 'chunk', text: piece });
            }
          }
        );

        if (!got.trim()) throw new Error('大儒一个字也没改定');

        send({ t: 'done' });
        closed = true;
        controller.close();
      } catch (err) {
        fail(err.message || '大儒呈作失败');
      }
    }
  });

  return {
    status: 200,
    body,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive'
    }
  };
}

/* ---------------- 方舟：非流式 ---------------- */

async function arkJson(messages, opts) {
  const { env, maxTokens, temperature, timeoutMs } = opts;

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
      messages
    })
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`模型应答异常（${resp.status}）${detail.slice(0, 160)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('模型没有给出内容');
  return content;
}

/* ---------------- 方舟：流式，逐块回调 ---------------- */

async function arkStream(messages, opts) {
  const { env, maxTokens, temperature, timeoutMs, onPiece } = opts;

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
      stream: true,
      messages
    })
  });

  if (!resp.ok || !resp.body) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`模型应答异常（${resp.status}）${detail.slice(0, 160)}`);
  }

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
