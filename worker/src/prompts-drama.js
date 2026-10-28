// 短剧编剧提示词：自 drama-writer/lib/prompts.mjs 移植。
// 四阶段：企划（JSON）→ 分集大纲（JSON）→ 逐集剧本（SUMMARY/SCRIPT 流式）
// → 不足篇幅扩写 → 去AI味润色。男频爽感驱动、女频情感驱动的差异在此拼装。

import { findDramaGenre, FREQ_LABEL } from './genres-drama.js';

// ── 频率特征 ─────────────────────────────────────────────────────────────

export function freqTraits(freq) {
  if (freq === 'male') {
    return {
      label: '男频短剧',
      core: '爽感驱动：受辱→觉醒→打脸→碾压，节奏快、反转多、爽点密集',
      pacing: '每集3-5个反转点，结尾必留钩子（悬念/打脸前奏）',
      emphasis: '注重实力碾压、身份反转、当众打脸的爽感',
      dialogue: '台词干脆利落，打脸名场面要有"金句"和"霸气发言"',
      emotion: '隐忍→爆发，男主克制有力，反派嚣张跋扈'
    };
  }
  return {
    label: '女频短剧',
    core: '情感驱动：虐→甜→误会→破镜重圆，情感线为核心',
    pacing: '每集1-2个情感转折点，结尾必留钩子（误会/虐心/甜宠反转）',
    emphasis: '注重情感拉扯、误会虐心、甜宠高光与双向奔赴',
    dialogue: '台词有情感张力，虐心名场面要扎心，甜宠场面要心动',
    emotion: '隐忍→心死→释然→甜蜜，女主坚韧独立，男主外冷内热'
  };
}

// ── 阶段 1：企划 ──────────────────────────────────────────────────────────

export function premiseSystem(freq) {
  const t = freqTraits(freq);
  return [
    '你是资深短剧编剧，专精' + t.label + '创作。',
    '任务：把用户的「大概情节」拓展成一份完整的短剧企划，包含：核心人物设定、主线冲突、情感/爽点节奏。',
    '只输出一个 JSON 对象，不要任何解释或代码块。',
    '',
    t.core + '。' + t.pacing + '。',
    '人物要鲜明立体：主角有记忆点（性格、口头禅或标志性动作），反派要嚣张到读者想看他被打脸。'
  ].join('\n');
}

export function premisePrompt(input) {
  const genre = findDramaGenre(input.freq, input.genre);
  const t = freqTraits(input.freq);
  return [
    '【频率】' + t.label,
    '【子类型】' + genre.name + '（' + genre.desc + '）',
    '【类型套路参考】' + genre.tropes.join('、'),
    '【用户大概情节】' + (input.plot || '（用户未提供，请根据子类型自拟一个完整情节）'),
    input.protagonist ? '【主角设定（用户提供）】' + input.protagonist : '',
    input.extra ? '【补充要求】' + input.extra : '',
    '',
    '输出 JSON，字段：',
    JSON.stringify({
      title: '短剧标题（吸引眼球，带悬念）',
      logline: '一句话故事梗概',
      genre: genre.name,
      freq: FREQ_LABEL[input.freq] || '男频',
      centralConflict: '主线冲突一句话',
      characters: [{ name: '姓名', role: '身份与性格', archetype: '原型标签', arc: '人物弧光' }],
      emotionArc: '情感/爽点节奏，用 → 连接',
      sellingPoints: ['核心卖点1', '核心卖点2'],
      twistCount: '反转次数预估'
    }),
    '要求：角色4-6个（含主角、对手、关键配角）；人物弧光要有变化（不是从头到尾一个样）；',
    'centralConflict 要具体到「谁和谁、因为什么、悬而未决什么」，不要泛泛而谈。'
  ].filter(Boolean).join('\n');
}

// ── 阶段 2：分集大纲 ──────────────────────────────────────────────────────

export function outlineSystem(freq) {
  const t = freqTraits(freq);
  return [
    '你是短剧结构师，专精' + t.label + '分集大纲设计。',
    '任务：根据企划设计分集大纲，每集有明确的剧情推进和结尾钩子。',
    '只输出一个 JSON 对象。',
    '',
    t.pacing + '。每集结尾必须留钩子（最后一集除外，需收束主线）。',
    '短剧每集时长短（1-3分钟），所以每集聚焦一个核心事件 + 一个反转/钩子，不要塞太多。'
  ].join('\n');
}

export function outlinePrompt(input, premise) {
  const t = freqTraits(input.freq);
  const n = input.episodes;
  return [
    '【企划JSON】',
    JSON.stringify(premise),
    '',
    '【总集数】' + n + '集',
    '【每集字数目标】约' + input.wordsPerEpisode + '字',
    '',
    '输出分集大纲 JSON：',
    JSON.stringify({
      title: premise.title,
      episodes: [{
        index: 1,
        title: '本集标题（4-8字，带悬念）',
        scene: '主要场景',
        beat: '本集剧情节拍',
        plot: '本集核心事件一句话',
        conflict: '本集冲突点',
        hook: '本集结尾钩子（最后一集写"主线收束"）',
        emotionTarget: '本集情感/爽点目标',
        wordTarget: input.wordsPerEpisode
      }]
    }),
    '要求：恰好' + n + '集；第1集必须快速进入冲突（前30秒就要有受辱/冲突/悬念钩子抓住观众）；',
    '剧情要层层递进，不能原地踏步；每集核心事件不重复；',
    '最后1集必须收束主线（' + (premise.centralConflict || '核心冲突') + '）给出明确结果。',
    t.emphasis + '。'
  ].join('\n');
}

// ── 阶段 3：逐集剧本 ──────────────────────────────────────────────────────

export function scriptSystem(freq) {
  const t = freqTraits(freq);
  return [
    '你是短剧编剧，专精' + t.label + '剧本撰写。',
    '严格按照分集大纲写作，输出规范的短剧剧本。',
    '',
    '【剧本格式规范】',
    '每集开头：第X集 标题',
    '场景标记：【场景X · 地点 · 时间（日/夜）】',
    '动作/场景描述：用圆括号（）包裹',
    '角色台词：角色名：台词内容',
    '旁白：旁白：内容',
    '',
    t.dialogue + '。',
    '字数是硬要求：本集正文必须达到字数目标的100%（允许-10%~+20%）；写到接近目标才允许收尾。',
    '结尾必须落在本集钩子上，要有"未完待续"的悬念感（最后一集除外）。',
    '输出格式（严格遵守）：第一行 SUMMARY: 50字内本集梗概；第二行 SCRIPT:；其后为完整剧本正文。',
    '不要JSON、不要代码块、不要Markdown标记（场景用【】、台词用角色名：即可）。'
  ].join('\n');
}

export function scriptPrompt(ctx) {
  const input = ctx.input;
  const premise = ctx.premise;
  const ep = ctx.episode;
  const recap = ctx.recap;
  const t = freqTraits(input.freq);
  return [
    '【短剧标题】' + premise.title,
    '【主线冲突】' + (premise.centralConflict || ''),
    '【人物】' + ((premise.characters || []).map((c) => c.name + '（' + (c.role || c.archetype || '') + '）').join('、')),
    '【本集信息】第' + ep.index + '集「' + ep.title + '」',
    '【本集场景】' + (ep.scene || ''),
    '【本集节拍】' + (ep.beat || ''),
    '【本集核心事件】' + (ep.plot || ep.beat || ''),
    '【本集冲突】' + (ep.conflict || ''),
    '【本集钩子】' + (ep.hook || ''),
    '【情感/爽点目标】' + (ep.emotionTarget || ''),
    '【本集字数目标】' + (ep.wordTarget || input.wordsPerEpisode) + '字',
    ctx.isFirst ? '【本集是全剧开头】前30秒内必须有冲突或悬念抓住观众，快速交代人物关系与核心冲突。' : '',
    ctx.isLast ? '【本集是全剧大结局】收束全部主线，核心冲突给出明确结果，人物结局交代清楚。' : '',
    '【前情提要】' + (recap || '（全剧开头，无前情）'),
    '',
    '写作要求：',
    '- 台词要符合人物性格，不能千人一面；',
    '- 每个场景有动作描写，不是纯对话堆砌；',
    '- 节奏紧凑，短剧每集信息密度高，不拖沓；',
    '- ' + t.emphasis + '。'
  ].filter(Boolean).join('\n');
}

// ── 阶段 4：扩写（字数不足时） ─────────────────────────────────────────────

export function expandSystem(freq) {
  const t = freqTraits(freq);
  return [
    '你负责把一集' + t.label + '剧本扩写到指定字数。保持原剧本的人物、情节、场景与风格。',
    '扩写手段：增加具体场景描写、动作细节、对话交锋与情绪刻画；不新增无关支线。',
    '输出格式与原稿相同：第一行 SUMMARY: 梗概；第二行 SCRIPT:；其后为扩写后的完整剧本。'
  ].join('\n');
}

export function expandPrompt(ctx) {
  return [
    '【本集信息】第' + ctx.episode.index + '集「' + ctx.episode.title + '」',
    '【扩写目标】不少于' + ctx.target + '字（当前仅' + ctx.currentChars + '字）',
    '',
    '【原文】',
    '<<<DRAFT',
    ctx.draft,
    'DRAFT>>>'
  ].filter(Boolean).join('\n');
}

// ── 阶段 5：润色去AI味 ────────────────────────────────────────────────────

export const POLISH_SYSTEM = [
  '你是严格的短剧剧本编辑。只做两类修改：①消除AI味表达 ②让台词更自然有张力。',
  '不改变情节、人物、场景与冲突。',
  '改写策略：抽象形容换成具体动作；删除说教式旁白；台词口语化、去书面腔；',
  '禁用「然而/与此同时/值得注意的是/不得不说/事实上」等议论文过渡语；',
  '禁用「不是…而是…」句式；禁用AI高频词（绽放、诠释、沉淀、岁月、时光、内心深处、救赎等）。',
  '直接输出润色后的完整剧本：不要解释、不要标题说明、不要 Markdown、不要代码块。'
].join('\n');

export function polishPrompt(ctx) {
  return [
    '【原剧本】',
    '<<<DRAFT',
    ctx.draft,
    'DRAFT>>>'
  ].join('\n');
}
