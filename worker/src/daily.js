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
const IMAGE_TIMEOUT_MS = 90_000; // 2560×1440 出图偏慢，60s 高峰易误杀
const VIDEO_CREATE_TIMEOUT_MS = 30_000;
const POLL_TIMEOUT_MS = 15_000;
const IMAGE_SIZE = '2560x1440'; // 16:9 高分辨率；与视频首帧同比例

// ★ 荐曲取大众熟知、引人沉思的轻音乐。file 可空：无本地音源者只陈曲目信息，
// 待 mp3 入 assets/audio 后再补 file 并 deploy。编号即推荐编号，与 manifest 无关。
const MUSIC_CATALOG = [
  { file: null, title: '夜的钢琴曲五', artist: '石进', mood: '静夜里独自流淌的琴音' },
  { file: null, title: 'Merry Christmas Mr. Lawrence', artist: '坂本龙一', mood: '克制而深远，余响不绝' },
  { file: null, title: '秋日私语', artist: '理查德·克莱德曼', mood: '如秋日散步的浪漫钢琴' },
  { file: null, title: 'One Summer’s Day', artist: '久石让', mood: '《千与千寻》，温柔回望' },
  { file: null, title: '故乡的原风景', artist: '宗次郎', mood: '陶笛里的远山与归途' },
  { file: null, title: 'Song from a Secret Garden', artist: '神秘园', mood: '低回的小提琴与钢琴' },
  { file: null, title: 'River Flows in You', artist: 'Yiruma', mood: '十指间如流水不息' },
  { file: null, title: '琵琶语', artist: '林海', mood: '低眉信手续续弹' },
  { file: null, title: 'Sundial Dreams', artist: 'Kevin Kern', mood: '日光穿过窗棂的梦' },
  { file: null, title: 'Annie’s Wonderland', artist: '班得瑞', mood: '林间晨光般的新世纪音' },
  { file: null, title: 'The Rain', artist: '久石让', mood: '《菊次郎的夏天》，悲欣交集' },
  { file: '恋恋风尘-程璧.mp3', title: '恋恋风尘', artist: '程璧', mood: '女声轻唱旧日时光' }
];

// 浅色调强制模板：只谈画风与禁忌，拼在画面内容之后，不依赖模型自觉，
// 也不与「画什么」抢权重。
const STYLE_SUFFIX =
  '画风：宋式写意、淡彩水墨，米白、淡牙白为底，大面积留白，光影柔和、线条细弱、简约安静；' +
  '仅用淡墨、灰青、浅赭石等低饱和矿物色。禁止高饱和色、霓虹、大红大绿、浓墨重彩、拥挤构图；' +
  '不出现清晰文字、印章与现代标牌；不得添加画面内容中未描述的人物、动物、植物与器物。';

// tone：heal 治愈性（默认）｜discuss 讨论性（抛一问、留话头）
const SAYING_CORE = {
  heal:
    '- saying：30–80 字的短句，清淡点拨人心，如宋人短语、如友朋耳语；' +
    '温柔安顿、不说教、不口号、不贴鸡汤标签；',
  discuss:
    '- saying：30–80 字的短句，有讨论性：对习以为常之事轻拨一问，或留一个开放话头，' +
    '让人想接住、想与人谈；可带立场但留余地，不做定论、不猎奇、不辩论腔、不鸡汤；'
};

function sayingSystem(tone) {
  return (
    '你是草屋衡几上的先生，为人日题一帖。只输出一个 JSON 对象，不要代码围栏、不要解释，字段：\n' +
    SAYING_CORE[tone] +
    '\n- imagePrompt：给画师的作画底稿，务必具体、每一个词都能被画出来，' +
    '不写情绪、意境、孤独之类抽象词（画师看不见这些）。' +
    '按「近景—远景」写清：主体只有一至二件，写明它是什么、材质、颜色、姿态、在画面中的位置；' +
    '陪衬景物限定两三样并写明位置；再写天光时令。整幅画面的景物不超过五样，' +
    '静态画面，不必出现文字与人脸；\n' +
    '- musicIndex：从下方曲目中选最贴合此心境的一首，给出其编号（整数）；\n' +
    '- reason：一句话说明为何选这首。\n\n' +
    '曲目：\n' +
    MUSIC_CATALOG.map((m, i) => `${i}. ${m.title} · ${m.artist}（${m.mood}）`).join('\n')
  );
}

/* ---------------- 入站净化 ---------------- */

const asStr = (v, max = Infinity) =>
  (typeof v === 'string' ? v.slice(0, max) : '');

// 高峰时限流/超时常见：新连接重试一次往往即通。心跳贯穿全程，前端不会因此断连。
async function withRetry(fn, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

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
    const tone = p.tone === 'discuss' ? 'discuss' : 'heal';
    const withImage = p.withImage !== false; // 默认 true
    const withVideo = p.withVideo === true;
    // 自定图/短片提示词：空串＝用先生所拟（默认）
    const imageHint = asStr(p.imageHint, HINT_MAX).trim();
    const videoHint = asStr(p.videoHint, HINT_MAX).trim();

    return {
      status: 200,
      mode: 'sse',
      body: streamCreate({ env, hint, tone, withImage, withVideo, imageHint, videoHint })
    };
  } catch (err) {
    return jsonError(502, phase, err.message || '每日简语失败');
  }
}

function jsonError(status, phase, error) {
  return { status, mode: 'json', body: { error, phase } };
}

/* ---------------- create：SSE 三阶段 ---------------- */

function streamCreate({ env, hint, tone, withImage, withVideo, imageHint, videoHint }) {
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

        const plan = await makePlan({ env, tone, user });
        stage('saying', 'done');
        send({ t: 'plan', ...plan });

        /* 阶段二：配图（失败不中断） */
        let imageUrl = '';
        let imageError = null;

        if (withImage) {
          stage('image', 'active');
          // 访客自定画面优先；无则用先生所拟
          const imagePromptUsed = imageHint || plan.imagePrompt;
          try {
            imageUrl = await withRetry(() => makeImage({ env, prompt: imagePromptUsed }));
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
                env, imageUrl, prompt: plan.imagePrompt, videoHint
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
          imagePrompt: imageHint || plan.imagePrompt,
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

async function makePlan({ env, tone, user }) {
  const rawCall = async () =>
    arkChatJson(
      [
        { role: 'system', content: sayingSystem(tone) },
        { role: 'user', content: user }
      ],
      { env, timeoutMs: SAYING_TIMEOUT_MS }
    );

  const firstText = await withRetry(rawCall);
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

  const track = MUSIC_CATALOG[index];
  return {
    saying,
    imagePrompt,
    tone,
    music: {
      index,
      title: track.title,
      artist: track.artist,
      file: track.file || null,
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
      // 内容与风格分层：主体内容前置并要求如实呈现，避免被后面的画风词冲淡
      prompt:
        `画面内容（必须如实呈现，不增不减，主体置于画面主要位置）：${prompt}\n${STYLE_SUFFIX}`,
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

async function makeVideoTask({ env, imageUrl, prompt, videoHint }) {
  // 访客自定动态优先；无则只给泛化的微动指令，画面描述沿用配图 prompt
  const motion = videoHint
    ? `由此静帧起，${videoHint}；动态缓慢克制，幅度小，意境与原画一致，时长约 5 秒。`
    : `由此静帧起，画面缓慢呼吸、微动：风过、云移、水流，幅度克制，` +
      `意境与原画一致，时长约 5 秒。${prompt}。`;

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
        { type: 'text', text: `${motion}\n${STYLE_SUFFIX}` },
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
