// 情感本写手提示词：自 emotion-scribe/app/lib/prompts.mjs 移入。
// 「人类指纹」= 反AI味规范。契约、写作、润色三处共用同一份 canon，
// 并与 deflavor.js 的检测规则一一对应：模型照规范写，检测器照规范查。
import { AI_TELL_WORDS } from './deflavor.js';

export const HUMAN_FINGERPRINT = [
  '1. 删除一切「解释自己」的句子：不写「仿佛在诉说」「像是在提醒」「这大概就是……」。',
  '2. 禁用句式：「不是……而是……」「与其说……不如说……」；禁用议论文过渡语（然而 / 与此同时 / 不得不说 / 值得注意的是 / 事实上）。',
  '3. 禁用高频AI词：' + AI_TELL_WORDS.slice(0, 18).join('、') + ' 等。',
  '4. 情绪不直陈：不写「我很难过 / 鼻子一酸 / 眼眶湿润 / 泪流满面」，用动作、物象、天气代替。',
  '5. 排比克制：连续同构短句不超过两句；不用「X的、X的、X的」三连形容词；每千字比喻不超过两处。',
  '6. 句长不规则：长短句交错，允许口语碎句；段落不要等长。',
  '7. 结尾禁升华：不总结、不点题、不写「多年以后我才明白」；最后一句落在物象或动作上。',
  '8. 感叹号全文不超过 3 处；省略号不超过 3 处；破折号不超过 2 处。'
].join('\n');

// ── 阶段 1：风格契约 ───────────────────────────────────────────────────────

export const CONTRACT_SYSTEM = [
  '你是资深中文文风分析师。任务：把用户的「文笔风格」和「风格要求」编译成一份可执行、可校验的「风格契约」。只输出一个 JSON 对象，不要任何解释。',
  '',
  '契约必须纳入「人类指纹」反AI味规范（这是硬规则的一部分，用户要求可加严）：',
  HUMAN_FINGERPRINT,
  '',
  '要求：hardRules 为 3-8 条可校验规则（必须包含上表第 2、3、4、7 条的等价表述）；avoid 中逐个列出用户禁忌词；imagery ≥4 个，优先取自用户风格描述中的元素。'
].join('\n');

export function contractPrompt(input) {
  return [
    '【文笔风格】',
    input.style,
    '',
    '【风格要求】',
    input.requirements,
    '',
    '【作品类型】' + input.genre,
    input.theme ? '【主题梗概】' + input.theme : '',
    input.mood ? '【情绪基调】' + input.mood : '',
    input.pov ? '【指定视角】' + input.pov : '',
    input.taboo && input.taboo.length ? '【禁忌词】' + input.taboo.join('、') : '',
    '',
    '输出 JSON，字段：',
    '{"name":"契约名","narrativeVoice":"人称与视角距离","tense":"时态与时间口吻","sentence":{"rhythm":"句式节奏","avgLength":"平均句长","paragraph":"段落习惯"},"vocabulary":{"prefer":["提倡用法"],"avoid":["回避词类与用户禁忌词"]},"imagery":["意象至少4个"],"emotionArc":"情绪走向，用 → 连接","hardRules":["可校验硬规则3-8条"],"sampleSentence":"亲手按该风格写的示例句","aiFree":true}'
  ].filter(Boolean).join('\n');
}

// ── 阶段 2：大纲（事件驱动版）─────────────────────────────────────────────

export const OUTLINE_SYSTEM = '你是情感类作品的结构设计师，擅长用事件驱动情感。铁律：情感必须由事件引发，没有事件就没有虐点。设计一条完整故事线——人物有明确欲望与阻碍（GMC），事件按三幕推进（激励事件 → 升级与中点反转 → 真相揭示 → 收束），每一章都必须让局面发生可见变化，禁止整章只有氛围与抒情。只输出一个 JSON 对象。';

export function outlinePrompt(input, contract) {
  return [
    '【作品类型】' + input.genre,
    '【主题梗概】' + (input.theme || '由你根据风格契约拟定一个贴近该文风的主题'),
    '【章节数】' + input.chapters,
    '【每章字数】' + input.wordsPerChapter,
    '',
    '请输出大纲 JSON，字段：',
    '{"title":"作品标题","logline":"一句话梗概","centralConflict":"主线冲突一句话：谁（欲望）被什么（阻碍）拦着，悬而未决的是什么","resolution":"结局一句话：主线如何收束、关系走向什么明确结果","characters":[{"name":"人物名","role":"身份与关系；主角请在 role 中写明「主角」二字","want":"此人最想要什么（具体可验证）","flaw":"性格缺陷或心结","secret":"藏着的秘密（可选）","tension":"与谁之间未解决的张力"}],"foreshadows":[{"setupChapter":1,"revealChapter":3,"item":"伏笔内容（物件/一句话/细节）"}],"chapters":[{"index":1,"title":"章节标题（不含序号，用具体物象）","goal":"本章主角要达成什么（场景目标）","obstacle":"本章谁/什么阻碍他","event":"本章核心事件，必须满足公式：起因→冲突/阻碍→转折或失败→新局面","plot":"本章核心事件一句话（发生了什么、主线推进了什么）","emotionTarget":"本章情绪目标（必须注明由哪个事件引发）","wordTarget":600,"hook":"单元末钩子（悬念或新问题）"}]}',
    '要求：恰好 ' + input.chapters + ' 章；',
    '- 人物欲望与关系张力是情节引擎：每个主要人物必须有 want 与 tension，冲突从欲望×阻碍里长出来，不许凭空抒情；',
    '- 第一章：1-2 段内交代「这是谁、想要什么、正被什么困住」，并在本章结尾点燃激励事件；',
    '- 每一章 event 必须满足「起因→冲突/阻碍→转折或失败→新局面」，结尾局面必须与开头不同（处境/关系/认知至少一项改变）；禁止整章只有回忆、氛围或心理独白；',
    '- 三幕节奏：前 1/3 章完成激励事件；中点章（第 ' + Math.ceil(input.chapters / 2) + ' 章附近）安排一次反转或真相；最后 1-2 章揭示真相并收束；',
    '- 情感反转：全篇至少安排 1 次（误解、真相迟来、牺牲、身份错位），且必须在 foreshadows 里埋设铺垫；',
    '- foreshadows 每条必须有 revealChapter（回收章），章节的揭示必须与 setup 配对，不许悬空；',
    '- 最后一章必须收束主线：核心悬念揭开、关系明确走向（和解 / 告别 / 自择其一）；留白只允许留在最后一句的意象上，不允许留在情节里；',
    '- 情绪沿契约 emotionArc 递进；章节标题用具体物象（如「未接来电」），不用「遗憾」「重逢」这类概括词。',
    '',
    '【风格契约JSON】',
    JSON.stringify(contract)
  ].join('\n');
}

// ── 阶段 3：逐章成稿 ──────────────────────────────────────────────────────

export const CHAPTER_SYSTEM = [
  '你是情感写作作者。严格按风格契约与大纲写作，并完整遵守「人类指纹」反AI味规范：',
  HUMAN_FINGERPRINT,
  '',
  '输出格式（严格遵守，不要 JSON、不要代码块）：第一行为「SUMMARY: 」加 50 字内本章梗概（用于衔接后文）；第二行为「PROSE:」；其后直接跟本章正文全文。',
  '字数是硬要求：正文必须达到【本章字数目标】的 100%（允许 -10% ~ +30%）；写到接近目标字数才允许收尾。',
  '情节完整是硬要求：本章必须完成【本章核心事件】并推进主线；若是第一章，开篇 1-2 段内自然交代人物、关系与当前处境；若是末章，收束全部主线（悬念揭开、关系走向明确），不得让人感觉故事没讲完。',
  '情节完整是硬要求（每章适用）：本章必须包含「目标 → 阻碍 → 行动 → 结果」四步中的至少三步，且结尾局面与开头不同（人物处境、关系或认知至少一项发生可见改变）。没有事件的章视为失败——禁止用抒情、回忆或心理独白代替事件。',
  '对白与行动优先：本章至少 1 段对白或 1 个可见行动推进情节；连续心理独白不超过本章篇幅的三分之一。',
  '篇幅不够时，用具体场景、动作、对话与物象细节展开；禁止用总结句、抒情句或重复句凑字数。',
  '正文：不带标题行、不用 Markdown；每段至少一个具体物象或动作；结尾落在指定钩子上。'
].join('\n');

export function chapterPrompt(ctx) {
  const input = ctx.input;
  const contract = ctx.contract;
  const outline = ctx.outline;
  const chapter = ctx.chapter;
  const recap = ctx.recap;
  const pending = ((outline.foreshadows || []).filter((f) => (f.setupChapter || 1) <= ctx.chapter.index && (f.revealChapter || 0) >= ctx.chapter.index)).map((f) => '第' + (f.setupChapter || 1) + '章埋设→第' + (f.revealChapter || '?') + '章回收：' + f.item);
  return [
    '【作品类型】' + input.genre,
    '【主题梗概】' + (input.theme || outline.logline || ''),
    '【章节数】' + input.chapters,
    '【人物】' + ((outline.characters || []).map((c) => c.name + '（' + c.role + '）' + (c.want ? '，想要' + c.want : '')).join('、') || '自拟'),
    outline.centralConflict ? '【主线冲突】' + outline.centralConflict : '',
    '【章节标题】' + chapter.title,
    '【本章节拍】' + (chapter.beat || ''),
    '【本章场景目标】' + (chapter.goal || ''),
    '【本章阻碍】' + (chapter.obstacle || ''),
    '【本章核心事件】' + (chapter.event || chapter.plot || chapter.beat || ''),
    '【情绪目标】' + (chapter.emotionTarget || ''),
    '【单元末钩子】' + (chapter.hook || ''),
    '【待回收伏笔】' + (pending.length ? pending.join('；') : '（无）'),
    '【本章字数目标】' + (chapter.wordTarget || input.wordsPerChapter),
    ctx.isFirst ? '【本章是全篇开头】开篇 1-2 段内自然交代：这是谁、想要什么、正被什么困住；本章结尾点燃激励事件。' : '',
    ctx.isLast ? '【本章是全篇末章】收束主线：' + (outline.centralConflict ? '核心悬念（' + outline.centralConflict + '）' : '核心悬念') + '给出揭示或确定走向' + (outline.resolution ? '，结局方向：' + outline.resolution : '') + '；情绪仍落在具体物象上，不写总结句。' : '',
    '【前情提要】' + (recap || '（本篇开头，无前情）'),
    '【意象库】' + (contract.imagery || []).join('、'),
    '【契约硬规则】' + (contract.hardRules || []).join('；'),
    '',
    '写作提醒：承接前情但不复述已写内容；本章必须发生「目标→阻碍→行动→结果」中至少三步，结尾局面与开头不同；对白与可见行动优先，连续心理独白不超过全章三分之一；至少使用意象库中 1 个意象；删掉一切解释情绪的句子。'
  ].join('\n');
}

// ── 阶段 3.5：字数不足扩写 ────────────────────────────────────────────────

export const EXPAND_SYSTEM = [
  '你负责把一章正文扩写到指定字数。保持原稿的人称、时态、风格、情节与意象体系；不得改变结局与核心转折。',
  '扩写手段：增加具体场景、动作、对话、物象细节与内心动作；允许补充推进主线的小事件（不改变结局与核心转折）；禁止用总结句、抒情句或重复句凑字数。',
  HUMAN_FINGERPRINT,
  '',
  '输出格式与原稿相同：第一行为「SUMMARY: 」加梗概；第二行为「PROSE:」；其后为扩写后的完整正文。'
].join('\n');

export function expandPrompt(ctx) {
  const contract = ctx.contract || {};
  return [
    '【文笔风格】' + ((ctx.input && ctx.input.style) || ''),
    '【风格要求】' + ((ctx.input && ctx.input.requirements) || ''),
    '【契约硬规则】' + (contract.hardRules || []).join('；'),
    '【意象库】' + (contract.imagery || []).join('、'),
    ctx.chapter && ctx.chapter.index ? '【本章信息】第' + ctx.chapter.index + '章「' + ctx.chapter.title + '」｜节拍：' + (ctx.chapter.beat || '') + '｜情绪：' + (ctx.chapter.emotionTarget || '') : '',
    '【扩写目标】不少于 ' + ctx.target + ' 字（当前仅 ' + ctx.currentChars + ' 字）',
    '',
    '【原文】',
    '<<<DRAFT',
    ctx.draft,
    'DRAFT>>>'
  ].filter(Boolean).join('\n');
}

// ── 阶段 4：去AI味润色 ────────────────────────────────────────────────────

export const POLISH_SYSTEM = [
  '你是严格的文风编辑。只做两类修改：①消除下方违规点 ②按「人类指纹」去AI味；不改变情节、人物、事实与意象体系；不得删除、改写或软化事件、转折与结局。',
  HUMAN_FINGERPRINT,
  '',
  '改写策略：抽象形容换成具体动作与物象；删除解释情绪的句子；超长句在自然气口断开；把句长改成不规则；不新增比喻；不新增形容词堆叠。',
  '直接输出润色后的完整正文：不要解释、不要标题、不要 Markdown、不要代码块。'
].join('\n');

export function polishPrompt(ctx) {
  const contract = ctx.contract || {};
  const chapter = ctx.chapter || {};
  const violations = ctx.violations || [];
  const vs = violations.map((v) => '[' + v.name + '×' + v.count + ']' + (v.samples && v.samples.length ? ' 如：' + v.samples.join('  ') : '')).join('\n');
  return [
    '【契约硬规则】' + (contract.hardRules || []).join('；'),
    '【回避词】' + ((contract.vocabulary && contract.vocabulary.avoid) || []).join('、'),
    '【违规点清单】',
    vs || '（无清单：按人类指纹通读一遍，能删则删）',
    chapter.index ? '【本章信息】第' + chapter.index + '章「' + chapter.title + '」｜情绪：' + (chapter.emotionTarget || '') : '',
    '',
    '【原文】',
    '<<<DRAFT',
    ctx.draft,
    'DRAFT>>>'
  ].filter(Boolean).join('\n');
}
