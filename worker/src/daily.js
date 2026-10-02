// 每日简语：衡几第四件器物的后端管线。手动起帖，无状态。
// 两 phase：
//   create —— SSE：起语（JSON）→ 文生图 →（可选）创建图生视频任务
//   poll   —— JSON：查视频任务（轮询由前端驱动，Worker 不挂长连）
// 媒体模型未配置或未开通时自动降级：图失败不毁文字，视频失败保留静图。

const ARK_BASE = 'https://ark.cn-beijing.volces.com';
const ARK_CHAT = `${ARK_BASE}/api/v3/chat/completions`;
const ARK_IMAGE = `${ARK_BASE}/api/v3/images/generations`;
const ARK_VIDEO = `${ARK_BASE}/api/v3/contents/generations/tasks`;

const HINT_MAX = 300;
const SAYING_TIMEOUT_MS = 90_000;
const IMAGE_TIMEOUT_MS = 60_000;
const VIDEO_CREATE_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 15_000;
const IMAGE_SIZE = '1280x720'; // 16:9，与视频首帧同比例

// ★ 与 assets/manifest.json 的 audio 数组同序同目。曲库改动两处同改并 deploy。
const MUSIC_CATALOG = [
  { file: '01-雨落草檐.mp3', title: '雨落草檐', sub: '雨丝与檐下流水，缓慢循环' },
  { file: '02-檐下流水.mp3', title: '檐下流水', sub: '檐角滴水，石上成声' },
  { file: '03-空山鸟语.mp3', title: '空山鸟语', sub: '山空无人，鸟声自来自去' },
  { file: 'Coce - Person.mp3', title: 'Person', sub: 'Coce' },
  { file: 'Judyesther - Sweet Dreams Carolin.mp3', title: 'Sweet Dreams, Carolina', sub: 'Judyesther' },
  { file: 'lonely hours grow.mp3', title: 'Lonely Hours Grow', sub: '曲库' },
  { file: 'love pain.mp3', title: 'Love Pain', sub: '曲库' },
  { file: 'overlaid.mp3', title: 'Overlaid', sub: '曲库' },
  { file: '恋恋风尘-程璧.mp3', title: '恋恋风尘', sub: '程璧' },
  { file: '春逝.mp3', title: '春逝', sub: '曲库' }
];

// 浅色调强制模板：拼在每条图/视频 prompt 末尾，不依赖模型自觉。
const STYLE_SUFFIX =
  '画面要求：米白、淡牙白为底，大面积留白；仅用淡墨、灰青、浅赭石等低饱和矿物色，' +
  '宋式写意、简约安静、光影柔和、线条细弱；禁止高饱和色、霓虹、大红大绿、浓墨重彩、' +
  '拥挤构图；不出现清晰文字、印章与现代标牌。';

const SAYING_SYSTEM =
  '你是草屋衡几上的先生，为人日题一帖。只输出一个 JSON 对象，不要代码围栏、不要解释，字段：\n' +
  '- saying：30–80 字的短句，清淡点拨人心，如宋人短语、如友朋耳语；不说教、不口号、不贴鸡汤标签；\n' +
  '- imagePrompt：一句具体可画的画面（有景有物、静态意境，不必出现文字），供画师作宋式浅色调图；\n' +
  '- musicIndex：从下方曲目中选最贴合此心境的一首，给出其编号（整数）；\n' +
  '- reason：一句话说明为何选这首。\n\n' +
  '曲目：\n' +
  MUSIC_CATALOG.map((m, i) => `${i}. ${m.title}（${m.sub}）`).join('\n');

/* ---------------- 入站净化 ---------------- */

const asStr = (v, max = Infinity) =>
  (typeof v === 'string' ? v.slice(0, max) : '');

/* ---------------- 入口 ---------------- */

export async function handleDaily(p, env) {
  const phase = p.phase === 'poll' ? 'poll' : 'create';

  if (!env.ARK_API_KEY) {
    return { status: 500, mode: 'json', body: { error: '后端未配置模型密钥', phase } };
  }

  try {
    if (phase === 'poll') {
      const taskId = asStr(p.taskId, 64).trim();
      if (!taskId) return jsonError(400, 'poll', '缺少视频任务编号');
      const body = await pollVideo({ env, taskId });
      return { status: 200, mode: 'json', body };
    }

    const hint = asStr(p.hint, HINT_MAX).trim();
    const withImage = p.withImage !== false; // 默认 true
    const withVideo = p.withVideo === true;

    return {
      status: 200,
      mode: 'sse',
      body: streamCreate({ env, hint, withImage, withVideo })
    };
  } catch (err) {
    return jsonError(502, phase, err.message || '每日简语失败');
  }
}

function jsonError(status, phase, error) {
  return { status, mode: 'json', body: { error, phase } };
}

/* ---------------- create：SSE 三阶段 ---------------- */

function streamCreate({ env, hint, withImage, withVideo }) {
  const today = new Date().toISOString().slice(0, 10);
  const weekday = '星期' + '日一二三四五六'[new Date().getDay()];

  return new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      let closed = false;

      const send = (obj) => {
        if (closed) return;
        controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      };
      const stage = (name, state) => send({ t: 'stage', stage: name, state });
      const fail = (msg) => {
        send({ t: 'error', error: msg });
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };

      // 心跳贯穿整个 create：高峰首字静默 40s+ 时不被看门狗误杀
      const beatTimer = setInterval(() => send({ t: 'ping' }), 12_000);

      try {
        send({ t: 'start' });

        /* 阶段一：起语 */
        stage('saying', 'active');
        const user =
          `今天是 ${today} ${weekday}。\n` +
          (hint
            ? `访客留题：${hint}\n\n请据此题起一句简语。`
            : '访客未留题。请按此时令、此日天气与季节的体会，自起一句简语。');

        const plan = await makePlan({ env, user });
        stage('saying', 'done');
        send({ t: 'plan', ...plan });

        /* 阶段二：配图（失败不中断） */
        let imageUrl = '';
        let imageError = null;

        if (withImage) {
          stage('image', 'active');
          try {
            imageUrl = await makeImage({ env, prompt: plan.imagePrompt });
            send({ t: 'image', url: imageUrl });
            stage('image', 'done');
          } catch (err) {
            imageError = err.message || '配图失败';
            send({ t: 'image', url: '', error: imageError });
            stage('image', 'warn');
          }
        }

        /* 阶段三：短片——只创建异步任务 */
        let video = null;
        if (withVideo) {
          stage('video', 'active');
          if (!imageUrl) {
            video = { error: imageError ? '配图未成，短片无从起首' : '无首帧，未呈短片' };
            stage('video', 'warn');
          } else if (!env.VIDEO_MODEL) {
            video = { error: '后端未配置视频模型' };
            stage('video', 'warn');
          } else {
            try {
              const taskId = await makeVideoTask({
                env, imageUrl, prompt: plan.imagePrompt
              });
              video = { taskId };
              send({ t: 'videoTask', taskId });
              stage('video', 'waiting');
            } catch (err) {
              video = { error: err.message || '短片创建失败' };
              stage('video', 'warn');
            }
          }
        }

        send({
          t: 'done',
          ...plan,
          imageUrl,
          imageError,
          video
        });
        closed = true;
        controller.close();
      } catch (err) {
        fail(err.message || '每日简语失败');
      } finally {
        clearInterval(beatTimer);
      }
    }
  });
}

/* ---------------- 阶段一：起语 JSON ---------------- */

async function makePlan({ env, user }) {
  const rawCall = async () =>
    arkChatJson(
      [
        { role: 'system', content: SAYING_SYSTEM },
        { role: 'user', content: user }
      ],
      { env, timeoutMs: SAYING_TIMEOUT_MS }
    );

  const firstText = await rawCall();
  let parsed = parseLoose(firstText);

  if (!parsed) {
    // 一次修复调用
    const repaired = await arkChatJson(
      [
        {
          role: 'system',
          content:
            '你是 JSON 修复器。只输出修正后的 JSON 对象，不要围栏不要解释。' +
            '结构：{saying,imagePrompt,musicIndex,reason}'
        },
        { role: 'user', content: `待修复文本：\n${firstText.slice(0, 2000)}` }
      ],
      { env, timeoutMs: SAYING_TIMEOUT_MS }
    );
    parsed = parseLoose(repaired);
  }
  if (!parsed) throw new Error('先生今日语不成句');

  // saying：去空白裁到 80 字内、截到句读
  let saying = String(parsed.saying || '').trim();
  const fold = saying.replace(/\s/g, '');
  if (fold.length > 80) {
    const head = fold.slice(0, 80);
    const m = head.match(/[\s\S]*[。！？…」』）”.!?]/);
    saying = (m ? m[0] : head);
  }
  if (!saying) throw new Error('先生今日没有留话');

  let imagePrompt = String(parsed.imagePrompt || '').trim().slice(0, 450) || saying;

  // 曲目：编号 → 标题模糊匹配 → saying 散列兜底，保证永远有荐曲
  let index = Math.round(Number(parsed.musicIndex));
  if (!(index >= 0 && index < MUSIC_CATALOG.length)) {
    const want = String(parsed.musicTitle || '').replace(/\s/g, '');
    index = MUSIC_CATALOG.findIndex(
      (m) => want && (m.title.replace(/\s/g, '').includes(want) || want.includes(m.title.replace(/\s/g, '')))
    );
  }
  if (index < 0) {
    let h = 0;
    for (const ch of saying) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    index = h % MUSIC_CATALOG.length;
  }

  return {
    saying,
    imagePrompt,
    music: {
      index,
      title: MUSIC_CATALOG[index].title,
      reason: String(parsed.reason || '').trim().slice(0, 80)
    }
  };
}

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

/* ---------------- 阶段二/三：媒体 ---------------- */

async function makeImage({ env, prompt }) {
  const resp = await fetch(ARK_IMAGE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.ARK_API_KEY}`
    },
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    body: JSON.stringify({
      model: env.IMAGE_MODEL,
      prompt: `${prompt}。${STYLE_SUFFIX}`,
      size: IMAGE_SIZE,
      response_format: 'url'
    })
  });
  if (!resp.ok) throw new Error(`画苑应答异常（${resp.status}）`);
  const data = await resp.json();
  const url = data?.data?.[0]?.url;
  if (!url) throw new Error('画苑没有交来画稿');
  return url;
}

async function makeVideoTask({ env, imageUrl, prompt }) {
  const resp = await fetch(ARK_VIDEO, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.ARK_API_KEY}`
    },
    signal: AbortSignal.timeout(VIDEO_CREATE_TIMEOUT_MS),
    body: JSON.stringify({
      model: env.VIDEO_MODEL,
      content: [
        {
          type: 'text',
          text:
            `由此静帧起，画面缓慢呼吸、微动：风过、云移、水流，幅度克制，` +
            `意境与原画一致，时长约 5 秒。${prompt}。${STYLE_SUFFIX}`
        },
        { type: 'image_url', image_url: { url: imageUrl } }
      ]
    })
  });
  if (!resp.ok) throw new Error(`影苑应答异常（${resp.status}）`);
  const data = await resp.json();
  const id = data?.id;
  if (!id) throw new Error('影苑没有收下短片任务');
  return id;
}

async function pollVideo({ env, taskId }) {
  const resp = await fetch(`${ARK_VIDEO}/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${env.ARK_API_KEY}` },
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS)
  });
  if (!resp.ok) throw new Error(`影苑应答异常（${resp.status}）`);
  const data = await resp.json();

  switch (data.status) {
    case 'succeeded': {
      const videoUrl = data?.content?.video_url;
      if (!videoUrl) return { status: 'failed', error: '短片交来时缺了画面' };
      return { status: 'succeeded', videoUrl };
    }
    case 'failed':
    case 'cancelled':
      return { status: 'failed', error: data.error?.message || '短片未成' };
    default: // queued / running
      return { status: 'running' };
  }
}

/* ---------------- 方舟：chat JSON ---------------- */

async function arkChatJson(messages, opts) {
  const { env, timeoutMs } = opts;
  const resp = await fetch(ARK_CHAT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.ARK_API_KEY}`
    },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model: env.MODEL,
      temperature: 0.85,
      max_tokens: 900,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      messages
    })
  });
  if (!resp.ok) throw new Error(`模型应答异常（${resp.status}）`);
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('模型没有给出内容');
  return text;
}
