// 草屋衡几 —— Cloudflare Worker
// 两件事：文案（查时事 Tavily → 组装知识库 → 方舟出稿）；决策研判（谋事参谋一轮直出）。

import { SYSTEM_PROMPT } from './prompt.js';
import { DECISION_PROMPT } from './prompt-decision.js';
import { FOX_PROMPT, FOX_TOOLS } from './prompt-fox.js';
import { psychology, classics } from './knowledge/index.js';

const TAVILY_URL = 'https://api.tavily.com/search';
const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const ARK_ANTHROPIC_URL = 'https://ark.cn-beijing.volces.com/api/coding/v1/messages';

const SEARCH_TIMEOUT_MS = 15_000;
const LLM_TIMEOUT_MS = 110_000;

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ error: '只接收 POST 请求' }, 405, cors);
    }

    // 白狐聊天：独立路径，透传 Anthropic 报文到方舟兼容入口
    const pathname = new URL(request.url).pathname;
    if (pathname === '/fox/chat') return handleFoxChat(request, env, cors);

    let brief = '';
    let type = 'copy';
    try {
      const data = await request.json();
      brief = (data.brief || '').trim();
      // type: 'copy'（缺省，旧调用方）| 'decision'（谋事参谋一轮研判）
      type = data.type === 'decision' ? 'decision' : 'copy';
    } catch {
      return json({ error: '请求体不是合法 JSON' }, 400, cors);
    }
    if (!brief) {
      return json({ error: type === 'decision' ? '先写下要参谋的事' : '先写下题目或困扰' }, 400, cors);
    }

    const today = new Date().toISOString().slice(0, 10);

    // 决策研判：不查时事、不拼典籍；流式透传，参谋边写边出，省去干等
    if (type === 'decision') {
      const dUser = `今天是 ${today}。\n\n待决策的事：\n${brief}\n\n请按固定格式一次输出完整研判报告。`;

      if (!env.ARK_API_KEY) return json({ error: '后端未配置模型密钥' }, 500, cors);

      let upstream;
      try {
        upstream = await fetch(ARK_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.ARK_API_KEY}`
          },
          signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
          body: JSON.stringify({
            model: env.MODEL,
            temperature: 0.3,
            max_tokens: 6144,
            thinking: { type: 'disabled' },
            stream: true,
            messages: [
              { role: 'system', content: DECISION_PROMPT },
              { role: 'user', content: dUser }
            ]
          })
        });
      } catch (err) {
        return json({ error: err.message || '模型调用失败' }, 502, cors);
      }

      if (!upstream.ok || !upstream.body) {
        const detail = await upstream.text().catch(() => '');
        return json({ error: `模型应答异常（${upstream.status}）${detail.slice(0, 200)}` }, 502, cors);
      }

      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store, no-transform',
          Connection: 'keep-alive',
          ...cors
        }
      });
    }

    // 1. 近期时事锚点（失败不中断，当作无锚点继续）
    const news = await searchNews(brief, env);

    // 2. 组装消息
    const system = `${SYSTEM_PROMPT}\n\n# 知识库（供检索，不要整段复述）\n\n${psychology}\n\n${classics}`;

    const newsBlock = news.length
      ? '\n\n# 近期时事（供作现实锚点，注明来源由系统另行展示，不要写进文案）\n' +
        news
          .map((n, i) => `${i + 1}. ${n.title}（${n.published || '日期未知'}）\n   ${n.snippet}\n   ${n.url}`)
          .join('\n')
      : '\n\n（本次未检索到时事素材，不要硬写时事。）';

    const user = `今天是 ${today}。\n\n访客的题目：\n${brief}${newsBlock}\n\n请直接给出文案。`;

    // 3. 调火山方舟
    let result;
    try {
      result = await callArk(system, user, env, 0.8);
    } catch (err) {
      return json({ error: err.message || '模型调用失败' }, 502, cors);
    }

    return json({ copy: result, sources: { news } }, 200, cors);
  }
};

/* ---------------- 白狐聊天：转发方舟 Anthropic 兼容入口 ---------------- */

async function handleFoxChat(request, env, cors) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: '请求体不是合法 JSON' }, 400, cors);
  }
  if (!Array.isArray(payload.messages)) {
    return json({ error: 'messages 必须是数组' }, 400, cors);
  }
  if (!env.ARK_API_KEY) return json({ error: '后端未配置模型密钥' }, 500, cors);

  const body = JSON.stringify({
    model: 'claude-sonnet-4-5', // 方舟侧映射；实测可直接用此名
    max_tokens: 1024,
    system: FOX_PROMPT,
    tools: FOX_TOOLS,
    messages: payload.messages
  });

  let upstream;
  try {
    upstream = await fetch(ARK_ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ARK_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      body
    });
  } catch (err) {
    return json({ error: err.message || '模型调用失败' }, 502, cors);
  }

  const text = await upstream.text().catch(() => '');
  return new Response(text, {
    status: upstream.status,
    headers: {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
      ...cors
    }
  });
}

/* ---------------- Tavily：近期时事 ---------------- */

async function searchNews(brief, env) {
  if (!env.TAVILY_API_KEY) return [];

  const query = `${brief.slice(0, 60)} 近期 社会 热点`;
  const ctrl = AbortSignal.timeout(SEARCH_TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch(TAVILY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl,
      body: JSON.stringify({
        api_key: env.TAVILY_API_KEY,
        query,
        max_results: 3,
        search_depth: 'basic',
        topic: 'general',
        days: 60,
        include_answer: false
      })
    });
  } catch {
    return [];
  }
  if (!resp.ok) return [];

  let data;
  try {
    data = await resp.json();
  } catch {
    return [];
  }

  return (data.results || []).map((r) => ({
    title: r.title || '',
    url: r.url || '',
    published: r.published_date || '',
    snippet: (r.content || '').slice(0, 300)
  }));
}

/* ---------------- 火山方舟：出稿 ---------------- */

async function callArk(system, user, env, temperature) {
  if (!env.ARK_API_KEY) throw new Error('后端未配置模型密钥');

  const resp = await fetch(ARK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.ARK_API_KEY}`
    },
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    body: JSON.stringify({
      model: env.MODEL,
      temperature: temperature,
      max_tokens: 4096,
      // V4-Pro 是推理模型，关思考：出稿不需要长推理，也免得调用等过百秒
      thinking: { type: 'disabled' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`模型应答异常（${resp.status}）${detail.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('模型没有给出内容');
  return content;
}

/* ---------------- 小工具 ---------------- */

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors }
  });
}

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const localhost = /^http:\/\/localhost:\d+$/.test(origin);
  if (origin && (allowed.includes(origin) || localhost)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    };
  }
  return {};
}
