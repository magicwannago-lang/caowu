/* ============================================================
   草屋 · 衡几
   两件器物：决策问答、文案起草。

   —— 各自怎么跑 ——
     决策问答 —— 由衡几上的「谋事参谋」（Cloudflare Worker）一轮直出：
                 把事说一次，不反问、不追问，参谋判类型、逐项研判，
                 一次摆出全盘。参谋不在（断网、后端停了），就退回
                 本地**必问清单**——七类型的问题都在，只是没有研判，
                 草屋不假装有智能。
     文案起草 —— 由衡几先生（同一个 Worker）代笔：后端保管
                 模型密钥、内置心理问题与儒释道典籍、联网查时事，
                 三重印证后出稿。先生不在（断网、后端停了），就
                 退回下面这副**骨架**——起承转合四段各该干什么、
                 别干什么。草屋不假装有智能，也不因为后端没了就
                 空着。

   不存任何东西、关掉页面即散。
   ============================================================ */

window.Hengji = (function () {
  'use strict';

  // 衡几（Worker）地址，见 ../worker/README.md
  var HEALING_API = 'https://hengji.sevencolor.space';

  /* ============================================================
     一、决策问答
     ============================================================ */

  /* ---------- 七类决策：本地只做词面粗判，可多选 ----------
     真正的研判由 Worker 侧的参谋完成；认不出来就归「权衡型」——
     「要不要」「选哪个」最常落在这里。判据与 worker/src/prompt-decision.js 同源。 */
  var TYPES = [
    {
      key: 'screen',
      name: '筛选型',
      re: /几款|几个|候选|挑一?[挑个]|筛选|对比|哪款好|哪个好|预算[线内以]?|硬(性)?(要求|门槛|条件)|资质|兼容|截止|达标/,
      ask: [
        '哪些条件是一票否决项？能否写成可验证的数字或书面凭证，不接受「差不多」？',
        '门槛是谁定的、会不会中途改？候选拿什么证明达标——合同、检测报告还是过往案例？',
        '候选是否同口径可比：报价、参数、交付范围是不是一回事，有没有漏项后补？',
        '被筛掉的将来还捡得回来吗？筛选本身的成本（比价、测试、尽调）值不值？'
      ]
    },
    {
      key: 'tradeoff',
      name: '权衡型',
      re: /要不要|该不该|怎么选|选哪|还是|纠结|犹豫|利弊|取舍|权衡|性价比|划算|便宜.*贵|贵.*便宜/,
      ask: [
        '若只能保一个指标，保哪个？权重能否量化（如 50/30/20），且权重在看选项之前定？',
        '哪些指标是「核心需求」，哪些是「锦上添花」？后者是否在冒充前者？',
        '每个方案具体牺牲什么、换来什么？这笔交换在什么条件下不划算？',
        '三年后回看，哪个选项最后悔（最小后悔原则）？',
        '能否组合——A 的主体加 B 的某项，或先 A 后 B 分阶段拿？'
      ]
    },
    {
      key: 'resource',
      name: '资源约束',
      re: /分配|预算不够|钱不够|时间不够|精力(不够|有限)|资源|上限|安排不[过来开]|分摊|挤|腾不[出]|够不够用/,
      ask: [
        '真实上限是多少，谁给的上限、有没有追加可能？',
        '哪一件事值得吃大头？保底项与可砍项分别是什么？',
        '留了多少缓冲？经验上同类事普遍超支/超时多少？缓冲由谁调用、用完怎么补？',
        '资源被占期间有新机会或急事进来怎么办？',
        '哪些环节可以钱换时间，哪些只能拿时间硬扛？'
      ]
    },
    {
      key: 'risk',
      name: '风险预判',
      re: /风险|担心|害怕?|怕(是|不)|会不会|能不能成|靠谱|出事|故障|副作用|安全吗|概率|万一|搞砸/,
      ask: [
        '最可能出问题的三个点是什么？各自概率与最大损失到什么量级——禁止只写「有风险」。',
        '最坏情况下能否承住：钱、时间、关系、健康，哪条线不能破？',
        '出现什么苗头就说明风险正在发生？多久查一次、谁负责发现？',
        '出了事按什么预定流程走：备用方案、备件、备选联系人在哪？',
        '哪些风险可转移（保险、违约条款、外包给专业方），转移成本多少；哪些只能自留？'
      ]
    },
    {
      key: 'duty',
      name: '责任归属',
      re: /谁(负责|来做|来管|担)|责任|合同|违约|验收|尾款|质保|担保|兜底|权责|分工|押[金一]|按实结算/,
      ask: [
        '谁决策、谁执行、谁验收、出事谁兜底——四个名字分别是谁？',
        '对方的承诺落在哪张纸上（合同、确认过的聊天记录、邮件）？口头承诺按没有处理。',
        '按什么标准判定是谁的责任？验收标准事先写清没有？',
        '付款杠杆留了多少：尾款、押金、质保金各自在什么条件下才放出？',
        '要不要引入第三方责任：保险、担保、平台介入？'
      ]
    },
    {
      key: 'longterm',
      name: '长期收益',
      re: /长期|三年|五年|十年|复利|维护|续费|折旧|值不值|值得吗|划算吗|沉没|以后|回本|持久/,
      ask: [
        '总持有成本多少：购入价之外的维护、续费、折旧、学习成本各是多少？',
        '收益曲线什么样：多久见效，复利或复用具体体现在哪里？',
        '三年后这件东西、关系或技能还在不在、还值不值？中途停手，已投入的还剩多少？',
        '持续维护需要你付出什么——钱、时间还是注意力，谁来做？',
        '现在图便宜的选项，将来推倒重来的代价多大？'
      ]
    },
    {
      key: 'irreversible',
      name: '不可逆',
      re: /不可逆|签约|辞职|离职|买房|卖房|搬家|领证|结婚|离婚|移民|退学|手术|违约|能不能退|反悔|最后(的)?(机会|时点)|定下来/,
      ask: [
        '撤回决定具体要付什么：违约金、搬迁、返工、关系破裂、错过时间窗口——量化到量级。',
        '有没有「先试再定」的路径：试用、短租、小批量、分阶段，用可逆小步逼近？',
        '最后一个反悔时点在哪：签约、付款、开工、公开宣布？过线前必须完成哪些尽调？',
        '再等几天能补齐什么关键信息？等待本身的代价又是什么？',
        '若必须今天定，最坏结果能否承受、几年能恢复？'
      ]
    }
  ];

  var FALLBACK_NINE = [
    '钱：总额多少——一次性支出、持续开销、隐性成本；上限是谁定的？',
    '时间精力：总耗时、维护精力、学习成本；其中需你本人出场多少天？',
    '目标匹配：核心需求能否一句话说清？哪些其实是锦上添花？',
    '风险兜底：最大损失到什么量级？有无备用方案？',
    '权责：决策、执行、验收、兜底，四个名字分别是谁？',
    '长期维护：后续迭代与定期更新谁做、花多少？',
    '机会成本：同一份资源投在这里，放弃的最好选项是什么？',
    '退出成本：如何终止？沉没多少、有无违约金或返工搬迁代价？',
    '功能性能：硬性能力清单是什么？兼容性如何？验收标准能否量化？'
  ];

  function typesOf(text) {
    var hits = TYPES.filter(function (t) { return t.re.test(text); });
    if (!hits.length) hits = [TYPES[1]]; // 认不出，按权衡型
    return hits;
  }

  /* 本地降级：一轮摆出清单，不含研判。诚实标明这是自问自答的单子。 */
  function decisionFallback(text) {
    var hits = typesOf(text);
    var L = [];

    L.push('【类型初判】');
    L.push(hits.map(function (t) { return t.name; }).join('、') +
           '（按词面粗判；真正的类型判定与逐项研判要等谋事参谋回来）。');
    L.push('');
    L.push('参谋今日不在，下面是照框架摆出的必问清单——不含研判，');
    L.push('你逐项自问自答即可。答完可再点一次「请参谋研判」。');
    L.push('');

    hits.forEach(function (t) {
      L.push('【必问清单 · ' + t.name + '】');
      t.ask.forEach(function (q, i) { L.push((i + 1) + '. ' + q); });
      L.push('');
    });

    L.push('【兜底九问】');
    FALLBACK_NINE.forEach(function (q, i) { L.push((i + 1) + '. ' + q); });

    return L.join('\n');
  }

  /* 参谋流式直出：onChunk(全文) 随写随调，调用方边收边渲染。
     返回完整报告；上游不 ok 或一个字都没收到，都按失败处理（由调用方退清单）。 */
  function advise(text, onChunk) {
    return fetch(HEALING_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'decision', brief: text })
    }).then(function (resp) {
      if (!resp.ok || !resp.body) throw new Error('参谋没有应答（' + resp.status + '）');

      var reader = resp.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var full = '';

      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return full;

          buffer += decoder.decode(r.value, { stream: true });

          // SSE 事件以空行分隔，逐事件取 data: 行
          var cut;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            var rawEvent = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);

            rawEvent.split('\n').forEach(function (line) {
              line = line.replace(/^data:/, '').trim();
              if (!line || line === '[DONE]') return;
              try {
                var piece = JSON.parse(line).choices[0].delta.content;
                if (piece) {
                  full += piece;
                  if (onChunk) onChunk(full);
                }
              } catch (e) { /* 忽略心跳与非标准行 */ }
            });
          }

          return pump();
        });
      }

      return pump();
    }).then(function (full) {
      if (!full.trim()) throw new Error('参谋一个字也没写');
      return full;
    });
  }

  /* ============================================================
     二、文案起草：一副骨架
     ============================================================ */

  /* 从题面里认几个东西，好让骨架贴着题目走。
     认不出也无妨——骨架本身就够用，只是通用一些。 */
  function readTopic(text) {
    var t = (text || '').trim();

    var seat = '自述';
    if (/都市|上班|通勤|打工|职场|白领|加班/.test(t)) seat = '都市人';
    else if (/创业|生意|副业|开店|客户|乙方/.test(t)) seat = '营生的人';
    else if (/读书|学生|毕业|考|论文|研究/.test(t)) seat = '读书人';
    else if (/父母|孩子|家庭|婚姻|相亲/.test(t)) seat = '为人亲者';

    var length = '短文（四百字上下）';
    if (/长文|深度|详|展开|万字/.test(t)) length = '长文（一千五百字以上）';
    else if (/短|一句|短语|口号|标题|slogan|几句/.test(t)) length = '短句（二三十字）';

    var tone = '克制清淡';
    if (/锋利|犀利|直接|直白|狠/.test(t)) tone = '锋利直白';
    else if (/温柔|暖|安慰|治愈/.test(t)) tone = '温和'
    else if (/幽默|俏皮|有趣|段子/.test(t)) tone = '轻松';

    var channel = '公众号 / 长文平台';
    if (/小红书|笔记/.test(t)) channel = '小红书';
    else if (/微博|朋友圈/.test(t)) channel = '微博 / 朋友圈';
    else if (/视频|口播|脚本|短视频|抖音|B站|bilibili/i.test(t)) channel = '口播脚本';

    return { seat: seat, length: length, tone: tone, channel: channel, brief: t };
  }

  function closeCopy(text) {
    var r = readTopic(text);
    var L = [];

    L.push('【落笔前先定四样】');
    L.push('题眼：一句话说清这篇到底在讲什么。写不出，就是还没想好，别开笔。');
    L.push('读者：' + r.seat + '。写的时候脑子里要有一个人，不是一群人。');
    L.push('分寸：' + r.length + '，' + r.tone + '。长短与口吻先定下，中途不改。');
    L.push('去处：' + r.channel + '。同一个意思，在哪儿说，说法不一样。');
    L.push('');

    L.push('【骨架 · 起】');
    L.push('做什么：用一个具体的场景或数字切入，不铺陈、不抒情、不问候。');
    L.push('两句为限。第一句就要让人往下看。');
    L.push('忌：不要以「在这个快节奏的时代」起头——那等于没起。');
    L.push('');

    L.push('【骨架 · 承】');
    L.push('做什么：把你的主张立住。一句结论，三句撑它，撑它的三句里至少有一句是别人没说过的话。');
    L.push('忌：不要先罗列。观点走在论据前头，人才跟得上。');
    L.push('');

    L.push('【骨架 · 转】');
    L.push('做什么：把反面摆出来——最像样的那个反驳，替反对你的人说完整，再回一句。');
    L.push('这一转是全文最值钱的地方，多数文章就死在没有这一转。');
    L.push('忌：不要拿稻草人当对手。挑最强的那个反驳来答。');
    L.push('');

    L.push('【骨架 · 合】');
    L.push('做什么：回到起首那个场景，给它一个交代。落到一个具体动作或一句可转述的话上。');
    L.push('忌：不要喊口号、不要「让我们一起」，不要许愿。收得干净比收得响亮好。');
    L.push('');

    L.push('【可抄的版式】');
    L.push('标题（不超过十四字，含一个具体名词）：');
    L.push('　　');
    L.push('起（两句）：');
    L.push('　　　　');
    L.push('承（结论 + 三条理由）：');
    L.push('　　一、');
    L.push('　　二、');
    L.push('　　三、');
    L.push('转（反面 + 回应）：');
    L.push('　　反面：');
    L.push('　　回应：');
    L.push('合（回扣 + 收束）：');
    L.push('　　');

    return L.join('\n');
  }

  /* ============================================================
     三、对外接口
     ============================================================ */

  /* 请衡几先生出稿：
     generate(brief) → Promise<{ copy, sources }>
     失败由调用方（main.js）降级到 draft() 骨架。 */
  function generate(brief) {
    return fetch(HEALING_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brief: brief })
    }).then(function (resp) {
      if (!resp.ok) throw new Error('先生没有应答（' + resp.status + '）');
      return resp.json();
    });
  }

  function draft(text) {
    if (!(text || '').trim()) {
      return '先写下题目。哪怕只是一句：「以……为题，写给……看」。\n没有题目，骨架也无处可搭。';
    }
    return closeCopy(text);
  }

  return { advise: advise, decisionFallback: decisionFallback, draft: draft, generate: generate };
})();
