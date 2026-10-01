// 大儒呈作：衡几第三件器物的后端管线。
// 无状态：四 phase 由前端分请求驱动 —— blueprint（JSON）/ chapter（SSE）/ review（JSON）/ finalize（SSE）。
// chapter、finalize 的 SSE 内部各带续写循环（runLoop），支持 seed 断点续接。

import {
  SCHOLAR_ROLE,
  BLUEPRINT_PROMPT,
  SECTION_DRAFT_SYSTEM,
  SECTION_FINAL_SYSTEM,
  continueInstruction,
  REVIEW_DEDUP_PROMPT,
  REVIEW_AI_PROMPT,
  REVIEW_SAFE_PROMPT,
  REVIEW_NAME
} from './prompt-book.js';

const ARK_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

const SPIRIT_MAX = 4000;
const MANUSCRIPT_MAX = 20000;
const BODY_PER_SECTION_MAX = 12000;
const PREV_TOTAL_MAX = 30000;

const BLUEPRINT_MAXTOK = 2500;
const ROUND_MAXTOK = 8192;
const REVIEW_MAXTOK = 1400;

// 字数到目标后等句读再中断；此为最长等待（句中硬切的兜底）
const STOP_GRACE = 200;

const BLUEPRINT_TIMEOUT_MS = 90_000;
const ROUND_TIMEOUT_MS = 110_000;
const REVIEW_TIMEOUT_MS = 80_000;

const PHASES = ['blueprint', 'chapter', 'review', 'finalize'];

/* ---------------- 入站净化 ---------------- */

const asStr = (v, max = Infinity) =>
  (typeof v === 'string' ? v.slice(0, max) : '');
const asNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const asObj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const asArr = (v) => (Array.isArray(v) ? v : []);

function sanitizeSection(o) {
  const s = asObj(o);
  if (!s) return null;
  const kind = ['front', 'body', 'back'].includes(s.kind) ? s.kind : 'body';
  return {
    id: asStr(s.id, 40),
    kind,
    title: asStr(s.title, 60),
    quota: Math.max(500, Math.min(9000, Math.round(asNum(s.quota) ?? 3000))),
    points: asArr(s.points).map((p) => asStr(p, 120)).filter(Boolean).slice(0, 4),
    fragments: asArr(s.fragments).map((f) => asStr(f, 400)).filter(Boolean).slice(0, 2),
    note: asStr(s.note, 400)
  };
}

function sanitizeBodies(arr, totalMax) {
  const out = [];
  let total = 0;
  for (const item of asArr(arr)) {
    const o = asObj(item);
    if (!o) continue;
    const body = asStr(o.body, BODY_PER_SECTION_MAX);
    if (total + body.length > totalMax) break;
    total += body.length;
    out.push({
      id: asStr(o.id, 40),
      kind: ['front', 'body', 'back'].includes(o.kind) ? o.kind : 'body',
      title: asStr(o.title, 60),
      body
    });
  }
  return out;
}

/* ---------------- 入口 ---------------- */

export async function handleBook(p, env) {
  const phase = PHASES.includes(p.phase) ? p.phase : null;
  const brief = asStr(p.brief, SPIRIT_MAX).trim();

  if (!phase) return jsonError(400, 'blueprint', '请求缺少合法的 phase');
  if (!brief) return jsonError(400, phase, '先写下作者精神状态与写书内核');
  if (!env.ARK_API_KEY) return jsonError(500, phase, '后端未配置模型密钥');

  const targetWords = Math.max(4000, Math.min(30000, Math.round(asNum(p.targetWords) ?? 10000)));
  const today = new Date().toISOString().slice(0, 10);
  const ctx = { brief, targetWords, today, env };

  try {
    if (phase === 'blueprint') {
      const manuscript = asStr(p.manuscript, MANUSCRIPT_MAX);
      const blueprint = await handleBlueprint({ ...ctx, manuscript });
      return { status: 200, mode: 'json', body: { blueprint } };
    }

    if (phase === 'chapter') {
      const section = sanitizeSection(p.section);
      if (!section || !section.title) return jsonError(400, phase, '缺少本节任务信息');
      return {
        status: 200,
        mode: 'sse',
        body: streamDraftSection({
          ...ctx,
          section,
          blueprint: sanitizeBlueprintLight(p.blueprint),
          prevSections: sanitizeBodies(p.prevSections, PREV_TOTAL_MAX),
          seed: asStr(p.seed, BODY_PER_SECTION_MAX * 2)
        })
      };
    }

    if (phase === 'review') {
      const sections = sanitizeBodies(p.sections, PREV_TOTAL_MAX + BODY_PER_SECTION_MAX);
      if (!sections.length) return jsonError(400, phase, '缺少待批阅的书稿');
      const reviews = await handleReview({ ...ctx, sections });
      return { status: 200, mode: 'json', body: { reviews } };
    }

    // phase === 'finalize'
    const scope = p.scope === 'chapter' ? 'chapter' : 'book';
    const reviews = asArr(p.reviews)
      .map((r) => {
        const o = asObj(r);
        return o ? { key: asStr(o.key, 20), text: asStr(o.text, 3000) } : null;
      })
      .filter(Boolean);

    if (scope === 'book') {
      const draft = asObj(p.bookDraft);
      const bookDraft = draft
        ? {
            title: asStr(draft.title, 60),
            sections: sanitizeBodies(draft.sections, PREV_TOTAL_MAX + BODY_PER_SECTION_MAX)
          }
        : null;
      if (!bookDraft || !bookDraft.sections.length) {
        return jsonError(400, phase, '缺少初稿全书');
      }
      return {
        status: 200,
        mode: 'sse',
        body: streamFinalizeBook({
          ...ctx,
          blueprint: sanitizeBlueprintLight(p.blueprint),
          bookDraft,
          reviews,
          seed: asStr(p.seed, PREV_TOTAL_MAX + BODY_PER_SECTION_MAX)
        })
      };
    }

    const section = sanitizeSection(p.section);
    if (!section || !section.title) return jsonError(400, phase, '缺少本节任务信息');
    const draft = asObj(p.bookDraft);
    const bookDraft = draft
      ? {
          title: asStr(draft.title, 60),
          sections: sanitizeBodies(draft.sections, PREV_TOTAL_MAX + BODY_PER_SECTION_MAX)
        }
      : { title: '', sections: [] };
    return {
      status: 200,
      mode: 'sse',
      body: streamFinalizeChapter({
        ...ctx,
        section,
        blueprint: sanitizeBlueprintLight(p.blueprint),
        bookDraft,
        finalized: sanitizeBodies(p.finalized, PREV_TOTAL_MAX),
        reviews,
        seed: asStr(p.seed, BODY_PER_SECTION_MAX * 2)
      })
    };
  } catch (err) {
    return jsonError(502, phase, err.message || '大儒呈作失败');
  }
}

function jsonError(status, phase, error) {
  return { status, mode: 'json', body: { error, phase } };
}

function sanitizeBlueprintLight(o) {
  const b = asObj(o);
  if (!b) return { title: '', manuscriptDigest: '', chapters: [] };
  return {
    title: asStr(b.title, 60),
    manuscriptDigest: asStr(b.manuscriptDigest, 700),
    chapters: asArr(b.chapters)
      .map((c) => {
        const co = asObj(c);
        return co ? { title: asStr(co.title, 60) } : null;
      })
      .filter(Boolean)
  };
}

/* ---------------- blueprint：JSON mode + 三级解析 ---------------- */

async function handleBlueprint({ env, brief, manuscript, targetWords, today }) {
  const user =
    `今天是 ${today}。全书目标字数：${targetWords} 字（去空白字符计）。\n\n` +
    `学生自述（精神状态 · 写书内核）：\n${brief}\n\n` +
    (manuscript.trim()
      ? `学生附来的原稿（部分正文与框架）：\n${manuscript}`
      : '（学生未附原稿，请据其自述独立成书。）');

  const rawCall = async () =>
    arkJson(
      [
        { role: 'system', content: BLUEPRINT_PROMPT },
        { role: 'user', content: user }
      ],
      { env, maxTokens: BLUEPRINT_MAXTOK, temperature: 0.6, timeoutMs: BLUEPRINT_TIMEOUT_MS, json: true }
    );

  let parsed = null;
  const first = await rawCall();
  parsed = parseLoose(first.text);

  if (!parsed) {
    // 一次修复调用
    const repaired = await arkJson(
      [
        {
          role: 'system',
          content:
            '你是 JSON 修复器。下面给出一份不合规的文本与预期结构，请只输出修正后的 JSON 对象，' +
            '不要代码围栏、不要解释。预期结构：' +
            '{title,prefaceTitle,prefaceNote,epilogueNote,manuscriptDigest,chapters:[{title,words,points,fragments}]}'
        },
        {
          role: 'user',
          content: `目标全书 ${targetWords} 字。原文本：\n${first.text.slice(0, 4000)}\n\n请修复为合规 JSON。`
        }
      ],
      { env, maxTokens: BLUEPRINT_MAXTOK, temperature: 0.3, timeoutMs: BLUEPRINT_TIMEOUT_MS, json: true }
    );
    parsed = parseLoose(repaired.text);
  }

  const bp = validateBlueprint(parsed, manuscript);
  if (!bp) throw new Error('蓝图不成体例');
  return bp;
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
    } catch { /* 继续下一种 */ }
  }
  return null;
}

function validateBlueprint(o, manuscript) {
  if (!o) return null;

  const title = String(o.title || '').replace(/[《》\s]/g, (m) => (m.trim() ? '' : m)).trim();
  if (title.length < 2 || title.length > 30) return null;

  const fold = (s) => s.replace(/\s/g, '');
  const foldedMs = fold(manuscript);

  const chapters = Array.isArray(o.chapters) ? o.chapters : [];
  const cleanChapters = [];
  for (const c of chapters) {
    if (!c || typeof c !== 'object') continue;
    const ct = String(c.title || '').trim();
    if (!ct || ct.length > 30) continue;

    let words = Math.round(Number(c.words));
    if (!Number.isFinite(words)) words = 3000;
    words = Math.max(500, Math.min(6000, words));

    const points = (Array.isArray(c.points) ? c.points : [])
      .map((p) => String(p || '').trim())
      .filter(Boolean)
      .slice(0, 4)
      .map((p) => p.slice(0, 80));
    while (points.length < 2) points.push(`「${ct}」的义理再展开`);

    const fragments = (Array.isArray(c.fragments) ? c.fragments : [])
      .map((f) => String(f || '').trim())
      .filter((f) => f && f.length <= 300 && foldedMs.includes(fold(f)))
      .slice(0, 2);

    cleanChapters.push({ title: ct, words, points, fragments });
  }
  if (cleanChapters.length < 2) return null;

  const prefaceTitle = String(o.prefaceTitle || '自序').trim().slice(0, 10) || '自序';
  const prefaceNote = String(o.prefaceNote || '').trim().slice(0, 200);
  const epilogueNote = String(o.epilogueNote || '').trim().slice(0, 200);
  const manuscriptDigest = String(o.manuscriptDigest || '').trim().slice(0, 600);

  return { title, prefaceTitle, prefaceNote, epilogueNote, manuscriptDigest, chapters: cleanChapters };
}

/* ---------------- chapter：起草单节 SSE ---------------- */

function streamDraftSection({ env, brief, targetWords, today, section, blueprint, prevSections, seed }) {
  const level = section.kind === 'body' ? '###' : '##';

  const chapterIndex =
    section.kind === 'body'
      ? blueprint.chapters.findIndex((c) => c.title === section.title) + 1
      : 0;

  const firstUser = () => {
    const lines = [
      `今天是 ${today}。`,
      '',
      '【学生自述 · 精神状态与写书内核】',
      brief,
      '',
      '【全书蓝图】',
      `书名：《${blueprint.title}》`,
      blueprint.manuscriptDigest ? `原稿提要：${blueprint.manuscriptDigest}` : '',
      blueprint.chapters.length
        ? '章目：' + blueprint.chapters.map((c, i) => `${i + 1}. ${c.title}`).join('；')
        : ''
    ];

    if (prevSections.length) {
      lines.push('', '【已写成的前各节（供承接，勿与重复）】');
      for (const ps of prevSections) {
        lines.push(`《${ps.title}》(节选全文)：`, ps.body);
      }
    }

    lines.push('', '【本节任务】');
    if (section.kind === 'front') {
      lines.push(`撰写序言《${section.title}》。${section.note}`);
    } else if (section.kind === 'back') {
      lines.push(`撰写后记《${section.title}》。${section.note}`);
    } else {
      lines.push(
        `撰写${chapterIndex ? `第 ${chapterIndex} 章` : '本章'}《${section.title}》。`,
        '本章论点：' + section.points.map((p, i) => `${i + 1}) ${p}`).join('；'),
        chapterIndex === blueprint.chapters.length ? '本章为末章，须收束全书，不另开新域。' : ''
      );
    }
    if (section.fragments.length) {
      lines.push('本节须化用的原稿原句：', ...section.fragments);
    }
    lines.push(`篇幅配额：至少 ${section.quota} 字（去空白字符计），请写足。`);

    return lines.filter((l) => l !== undefined && l !== '').join('\n');
  };

  return runLoop({
    env,
    quota: section.quota,
    heading: { title: section.title, level },
    maxRounds: 4,
    seed,
    temperature: 0.85,
    system: SECTION_DRAFT_SYSTEM,
    firstUser,
    startInfo: { sectionId: section.id }
  });
}

/* ---------------- finalize / book：全书定稿 SSE ---------------- */

function streamFinalizeBook({ env, brief, targetWords, today, blueprint, bookDraft, reviews, seed }) {
  const firstUser = () => assembleFinalizeUser({
    today, brief, targetWords, blueprint, reviews,
    body: assembleDraft(bookDraft)
  });

  return runLoop({
    env,
    quota: targetWords,
    heading: null, // 全书续写，无单一标题
    maxRounds: 4,
    seed,
    temperature: 0.75,
    system: SECTION_FINAL_SYSTEM,
    firstUser,
    startInfo: { scope: 'book' }
  });
}

/* ---------------- finalize / chapter：逐节定稿 SSE ---------------- */

function streamFinalizeChapter({
  env, brief, targetWords, today, section, blueprint, bookDraft, finalized, reviews, seed
}) {
  const level = section.kind === 'body' ? '###' : '##';

  const firstUser = () => {
    const lines = [
      assembleFinalizeUser({ today, brief, targetWords, blueprint, reviews, body: assembleDraft(bookDraft) }),
      '',
      '【本轮只修订这一节】',
      `《${section.title}》，配额不少于 ${section.quota} 字。`
    ];
    if (finalized.length) {
      lines.push('已定稿的前各节（口吻以此为准）：');
      for (const fs of finalized) lines.push(`《${fs.title}》：`, fs.body);
    }
    return lines.join('\n');
  };

  return runLoop({
    env,
    quota: section.quota,
    heading: { title: section.title, level },
    maxRounds: 3,
    seed,
    temperature: 0.75,
    system: SECTION_FINAL_SYSTEM,
    firstUser,
    startInfo: { scope: 'chapter', sectionId: section.id }
  });
}

function assembleFinalizeUser({ today, brief, targetWords, blueprint, reviews, body }) {
  const lines = [
    `今天是 ${today}。`,
    '',
    '【学生自述 · 精神状态与写书内核】',
    brief,
    '',
    '【全书蓝图】',
    blueprint.title ? `书名：《${blueprint.title}》` : '',
    blueprint.manuscriptDigest ? `原稿提要：${blueprint.manuscriptDigest}` : '',
    blueprint.chapters.length
      ? '章目：' + blueprint.chapters.map((c, i) => `${i + 1}. ${c.title}`).join('；')
      : '',
    '',
    '【初稿全文】',
    body,
    '',
    '【三校批阅意见】',
    reviews.length
      ? reviews.map((r) => `【${REVIEW_NAME[r.key] || r.key}】\n${r.text || '无'}`).join('\n\n')
      : '无'
  ];
  lines.push('', `请据意见修订为定稿；全书非空白字数不得少于 ${targetWords}，篇幅只许补足、不许缩水。`);
  return lines.filter((l) => l !== undefined && l !== '').join('\n');
}

function assembleDraft(bookDraft) {
  const out = [`# ${bookDraft.title}`];
  for (const s of bookDraft.sections) {
    const lvl = s.kind === 'body' ? '###' : '##';
    out.push(`${lvl} ${s.title}`, '', s.body);
  }
  return out.join('\n');
}

/* ---------------- review：三校并行（非流式） ---------------- */

async function handleReview({ env, brief, sections }) {
  const manuscript = sections
    .map((s) => {
      const lvl = s.kind === 'body' ? '###' : '##';
      return `${lvl} ${s.title}\n\n${s.body}`;
    })
    .join('\n\n');

  const judges = [
    { key: 'dedup', prompt: REVIEW_DEDUP_PROMPT },
    { key: 'ai', prompt: REVIEW_AI_PROMPT },
    { key: 'safe', prompt: REVIEW_SAFE_PROMPT }
  ];

  const results = await Promise.allSettled(
    judges.map((j) =>
      arkJson(
        [
          { role: 'system', content: j.prompt },
          { role: 'user', content: `学生自述：\n${brief}\n\n书稿全文：\n${manuscript}` }
        ],
        { env, maxTokens: REVIEW_MAXTOK, temperature: 0.2, timeoutMs: REVIEW_TIMEOUT_MS }
      )
    )
  );

  return judges.map((j, i) => {
    const r = results[i];
    if (r.status === 'fulfilled' && r.value.text.trim()) {
      return { key: j.key, name: REVIEW_NAME[j.key], text: r.value.text.trim(), missing: false };
    }
    return { key: j.key, name: REVIEW_NAME[j.key], text: '（该校书今日失约，无意见）', missing: true };
  });
}

/* ---------------- runLoop：draft/final 共用的续写循环 ---------------- */

function runLoop(opts) {
  const {
    env, quota, heading, maxRounds, seed, temperature, system, firstUser, startInfo
  } = opts;

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

      try {
        let text = seed ? cleanSeed(seed, heading) : '';
        let apiCalls = 0;
        let stoppedBySentinel = false;
        let lastProgressEmit = 0;

        send({ t: 'start', ...startInfo, seeded: Boolean(seed) });
        if (text) send({ t: 'progress', chars: countChars(text), quota });

        for (let round = 1; round <= maxRounds; round++) {
          send({ t: 'round', round, maxRounds });

          let acc = '';
          let finishReason = '';
          let enough = false;
          // 字数闸：token→字转化率漂移（实测 0.6–1.4），按 max_tokens 限幅不可靠；
          // 流式中直接数字数，到 quota＋一句 grace 即中断上游，篇幅才守得住。
          const roundAbort = new AbortController();

          const isFirstCall = apiCalls === 0;
          let messages;
          if (!isFirstCall) {
            messages = [
              { role: 'system', content: system },
              {
                role: 'user',
                content: `${continueInstruction(anchorOf(text))}\n\n【已写全文】\n${text}`
              }
            ];
          } else if (seed) {
            // 首调即带残稿：原任务照给，残稿另列，明令接续——
            // 不能只重发原任务（模型看不见残稿，会从头另写，拼成断章）。
            messages = [
              { role: 'system', content: system },
              { role: 'user', content: seededFirstUser(firstUser(), text) }
            ];
          } else {
            messages = [{ role: 'system', content: system }, { role: 'user', content: firstUser() }];
          }

          try {
            await arkStream(messages, {
              env,
              maxTokens: ROUND_MAXTOK,
              temperature,
              timeoutMs: ROUND_TIMEOUT_MS,
              signal: roundAbort.signal,
              onPiece: (piece) => {
                acc += piece;
                send({ t: 'chunk', text: piece });
                const now = Date.now();
                if (now - lastProgressEmit > 600) {
                  lastProgressEmit = now;
                  send({ t: 'progress', chars: countChars(text + acc), quota });
                }
                if (!enough) {
                  const liveChars = countChars(text + acc);
                  const tail = acc.replace(/\s+$/, '').slice(-1);
                  const atPause = liveChars >= quota && /[。！？…」』）”]/.test(tail);
                  if (atPause || liveChars >= quota + STOP_GRACE) {
                    enough = true;
                    roundAbort.abort();
                  }
                }
              },
              onFinish: (reason) => { finishReason = reason; }
            });
          } catch (err) {
            // 自家字数闸触发的中断视作正常收笔；其余（超时等）继续抛
            if (!(enough && err.name === 'AbortError')) throw err;
          }
          apiCalls++;

          let addition = acc;
          if (!isFirstCall || seed) {
            if (heading) addition = stripDupHeading(addition, heading.title, heading.level);
            addition = stripEcho(addition, text);
          }

          text += addition;

          // 字数闸 abort 是异步的：触发后，上游已缓冲的零星残字可能在
          // reader 真正中断前又漏进来。截到最后一个句读，不留悬尾。
          if (enough) {
            const clean = text.match(/[\s\S]*[。！？…」』）”]/);
            if (clean) text = clean[0].replace(/\s+$/, '');
          }

          const sentinel = takeSentinel(text);
          if (sentinel) { text = sentinel; stoppedBySentinel = true; }

          const chars = countChars(text);
          send({ t: 'progress', chars, quota });

          // 句读才算写完：模型可能在句中断流（finish=stop 也会），
          // 此时须续写，不可在轮末当完成。
          const endsClean = /[。！？…」』）”]/.test(text.replace(/\s+$/, '').slice(-1));

          if (stoppedBySentinel) {
            send({ t: 'done', chars, rounds: apiCalls, short: chars < quota * 0.85, sentinel: true });
            break;
          }

          if (enough) {
            send({ t: 'done', chars, rounds: apiCalls, short: false });
            break;
          }
          if (chars >= quota * 0.9 && endsClean) {
            send({ t: 'done', chars, rounds: apiCalls, short: false });
            break;
          }
          if (finishReason === 'stop' && chars >= quota * 0.85 && endsClean) {
            send({ t: 'done', chars, rounds: apiCalls, short: false });
            break;
          }
          if (round === maxRounds) {
            send({ t: 'done', chars, rounds: apiCalls, short: true });
            break;
          }
          // 否则进入续写轮
        }

        closed = true;
        controller.close();
      } catch (err) {
        fail(err.message || '大儒呈作失败');
      }
    }
  });
}

/* ---------------- 文本卫生 ---------------- */

// 去空白字符计数；markdown 标题行不计（标题由成书统一编排）。
function countChars(s) {
  return s
    .split('\n')
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join('')
    .replace(/\s/g, '').length;
}

function cleanSeed(seed, heading) {
  let t = seed.replace(/^\s+/, '');
  if (heading) t = stripDupHeading(t, heading.title, heading.level);
  const sentinel = takeSentinel(t);
  return sentinel || t;
}

// 续写首行若重复了本节同名标题，剥掉。
function stripDupHeading(add, title, level) {
  const rest = add.replace(/^\s+/, '');
  const nl = rest.indexOf('\n');
  const firstLine = nl >= 0 ? rest.slice(0, nl) : rest;
  const m = firstLine.match(/^\s*(#{1,6})\s+(.*?)\s*$/);
  if (m && m[1] === level && m[2].replace(/\s/g, '') === title.replace(/\s/g, '')) {
    return nl >= 0 ? rest.slice(nl + 1).replace(/^\s+/, '') : '';
  }
  return add;
}

// 续写若复述了已写末尾，按最长重叠剥掉（折叠空白后比较，阈值 24 字防误伤）。
function stripEcho(add, full) {
  if (!add.trim() || !full.trim()) return add;
  const fold = (s) => s.replace(/\s/g, '');
  const aFold = fold(add);
  const tFold = fold(full.slice(-260));
  const max = Math.min(aFold.length, tFold.length, 200);

  for (let cut = max; cut >= 24; cut--) {
    if (tFold.slice(-cut) === aFold.slice(0, cut)) {
      // 从 add 开头删掉 cut 个非空白字符（空白不计）
      let n = cut;
      let i = 0;
      while (i < add.length && n > 0) {
        if (/\s/.test(add[i])) { i++; continue; }
        n--; i++;
      }
      return add.slice(i).replace(/^\s+/, '');
    }
  }
  return add;
}

function anchorOf(text) {
  return text.trimEnd().slice(-120).replace(/\s+/g, ' ');
}

// seed 首调：原任务全文在前，残稿在后，明令紧接续写、不得从头另写。
function seededFirstUser(taskUser, seedText) {
  return [
    taskUser,
    '',
    '【上次管线中断，下面是已写成的部分——这是已定的文字】',
    seedText.trimEnd(),
    '',
    '请将其当作已写就的部分：不要从头重写、不要复述，紧接其后继续写，',
    '把配额补足；体例、口吻与已写部分保持一致。'
  ].join('\n');
}

// 检测末尾独占一行的 [章成]，返回剥除标记后的文本。
function takeSentinel(s) {
  const m = s.match(/\s*\[章成\]\s*$/);
  if (!m) return null;
  return s.slice(0, s.length - m[0].length).replace(/\s+$/, '\n\n');
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

  if (!resp.ok) {
    // 不透传上游响应体：其中可能夹带敏感信息，只报状态码
    throw new Error(`模型应答异常（${resp.status}）`);
  }

  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('模型没有给出内容');
  return { text, finishReason: data?.choices?.[0]?.finish_reason || '' };
}

/* ---------------- 方舟：流式，逐块回调 ---------------- */

async function arkStream(messages, opts) {
  const { env, maxTokens, temperature, timeoutMs, signal, onPiece, onFinish } = opts;

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

  if (!resp.ok || !resp.body) {
    // 不透传上游响应体，只报状态码
    throw new Error(`模型应答异常（${resp.status}）`);
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
          const choice = JSON.parse(line).choices?.[0];
          const piece = choice?.delta?.content;
          if (piece) onPiece(piece);
          if (choice?.finish_reason && onFinish) onFinish(choice.finish_reason);
        } catch { /* 忽略心跳与非标准行 */ }
      });
    }
  }
}
