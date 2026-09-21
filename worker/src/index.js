// 草屋衡几·治愈文案师 —— Cloudflare Worker
// 替静态页面保管密钥：查近期时事（Tavily）→ 组装知识库 → 调火山方舟 DeepSeek 出稿。

import { SYSTEM_PROMPT } from './prompt.js';
import { psychology, classics } from './knowledge/index.js';

const TAVILY_URL = 'https://api.tavily.com/search';
const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

const SEARCH_TIMEOUT_MS = 15_000;
const LLM_TIMEOUT_MS = 90_000;

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

    let brief = '';
    try {
      const data = await request.json();
      brief = (data.brief || '').trim();
    } catch {
      return json({ error: '请求体不是合法 JSON' }, 400, cors);
    }
    if (!brief) {
      return json({ error: '先写下题目或困扰' }, 400, cors);
    }

    // 1. 近期时事锚点（失败不中断，当作无锚点继续）
    const news = await searchNews(brief, env);

    // 2. 组装消息
    const today = new Date().toISOString().slice(0, 10);
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
      result = await callArk(system, user, env);
    } catch (err) {
      return json({ error: err.message || '模型调用失败' }, 502, cors);
    }

    return json({ copy: result, sources: { news } }, 200, cors);
  }
};

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

async function callArk(system, user, env) {
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
      temperature: 0.8,
      max_tokens: 4096,
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
