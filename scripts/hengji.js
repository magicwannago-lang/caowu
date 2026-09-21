/* ============================================================
   草屋 · 衡几
   两件器物：决策问答、文案起草。

   —— 各自怎么跑 ——
     决策问答 —— 是一套**问法**，不是答案。按次序问该问的，
                 最后把你说过的话摆回你面前。答的人始终是你。
                 纯本地，不联网。
     文案起草 —— 由衡几先生（Cloudflare Worker）代笔：后端保管
                 模型密钥、内置心理问题与儒释道典籍、联网查时事，
                 三重印证后出稿。先生不在（断网、后端停了），就
                 退回下面这副**骨架**——起承转合四段各该干什么、
                 别干什么。草屋不假装有智能，也不因为后端没了就
                 空着。

   不存任何东西、关掉页面即散。
   ============================================================ */

window.Hengji = (function () {
  'use strict';

  // 衡几先生（Worker）地址，部署后回填，见 ../worker/README.md
  var HEALING_API = 'https://caowu-healing.workers.dev';

  /* ============================================================
     一、决策问答
     ============================================================ */

  /* ---------- 认一认：这事儿属于哪一类 ----------
     只认三分，认不出就按「取舍」问——那是最大的一类，
     也是「要不要」这种问法最常落的地方。 */
  var KIND_RULES = [
    {
      key: 'binary',
      // 走或留、做或不做，两个选项已经摆在桌上
      re: /要不要|该不该|是否|做还是不做|去还是留|该不该|选哪|还是(不|别)/,
      first: '眼前是两条路，各有一条的代价。'
    },
    {
      key: 'stuck',
      // 没在选，是卡住了
      re: /纠结|犹豫|拿不定|卡住|下不了|不知道该怎么|无从/,
      first: '不是选不出来，是还没想清楚在选什么。'
    },
    {
      key: 'timing',
      // 方向已定，只在问什么时候
      re: /什么时候|时机|现在(做|开始|上手)|来得及|时机成熟/,
      first: '方向已定，剩下的只是时候。'
    }
  ];

  var KIND_DEFAULT = {
    key: 'tradeoff',
    first: '决定之前，先把「舍」的那一半看清楚。'
  };

  function kindOf(text) {
    for (var i = 0; i < KIND_RULES.length; i++) {
      if (KIND_RULES[i].re.test(text)) return KIND_RULES[i];
    }
    return KIND_DEFAULT;
  }

  /* ---------- 问法：每一步只问一件事 ----------
     次序不是随意的：
       1 先立目标（没有目标，后面的得失都无处安放）
       2 再看代价（两边的舍，都要看见）
       3 再问最坏（能不能承住，是硬底线）
       4 再问不做（很多纠结是怕动，不是怕错）
       5 最后问十年（把尺度拉长，滤掉一阵一阵的情绪）
     垫话按类型分岔，问题本身不动——问题要稳，问的人不能跟着情绪走。 */
  var STEPS = [
    {
      id: 'aim',
      ask: '先把事说清楚：这件事，你真正想要的是什么？\n不是「我希望」，而是「没有它我就不算成」的那一样。',
      hint: '若写下来有三样以上，那还没说清楚。',
      lead: {
        tradeoff: '第一问，先把标尺立起来。'
      }
    },
    {
      id: 'give',
      ask: '两边各自的代价，分别是什么？\n要具体到：钱、时间、关系、名声、身体——哪一样，多少。',
      hint: '含糊的代价会在事后变成惊讶。',
      lead: {
        binary: '两个选项已经摆在桌上，那就把两边的账都摊开。',
        timing: '再等等的代价，和你现在就动手的代价，是两笔账。',
        stuck: '卡住的地方，常常就在这笔没算的账上。'
      }
    },
    {
      id: 'worst',
      ask: '最坏的结果是什么？落到最坏那一步，你还能不能过下去？\n请回答「能」或「不能」，并说一句为什么。',
      hint: '这一问是底线，不是吓唬。答「不能」的，就不必往下问了。',
      lead: {
        tradeoff: '第三问，问底线。'
      }
    },
    {
      id: 'nothing',
      ask: '如果什么都不做，三个月后会怎样？\n写具体的：还在原地，还是已经错过。',
      hint: '「不动」也是一个选项，且通常有代价。',
      lead: {
        timing: '时机之问，多半是这一个问题的变体。',
        stuck: '这一问常能把卡住的人推出来。'
      }
    },
    {
      id: 'long',
      ask: '十年后回头看，你会后悔的是哪一边？\n只说哪一边，不必解释。',
      hint: '把尺度拉长，一阵一阵的情绪会自己退掉。',
      lead: {
        binary: '最后一问，把尺子拉到十年。',
        tradeoff: '最后一问，把尺子拉到十年。'
      }
    }
  ];

  // 追问时的承接语：认得出来的就先接一句，认不出来就照常往下问
  function acknowledge(step, answer) {
    var a = (answer || '').trim();

    if (step.id === 'worst') {
      if (/^不/.test(a) || /不能|受不了|承不住|撑不住/.test(a)) {
        return '既然承不住，那这一条就该被划掉——不必再看它值多少。';
      }
      if (/能|可以|还行|扛得住|顶得住/.test(a)) {
        return '能承住，那就只剩下值不值的问题了。';
      }
      return '这一条记下了。';
    }

    if (step.id === 'nothing') {
      if (/错过|来不及|失去|后悔|更糟|变差/.test(a)) {
        return '「不动」也在往前走，这一点你看见了。';
      }
      if (/原地|不变|还是|照旧|一样/.test(a)) {
        return '既然不动就还在原地，那就不是在「等」，是在「选现在这样」。';
      }
      return '这一条记下了。';
    }

    if (step.id === 'long') {
      if (/都|两|说不清|不后悔|无所谓/.test(a)) {
        return '两个都后悔，说明差的不是选择，是别的什么——那更值得再想想。';
      }
      return '好，这一条是秤上最后一块砝码。';
    }

    if (step.id === 'give' && a.length < 12) {
      return '账写得短。要不再补一句：代价具体落到哪一样上？';
    }

    return '';
  }

  /* ---------- 收尾：不给答案，给一面镜子 ----------
     只做三件事：摆出说过的话、指出自相矛盾之处、给出最后三问。
     绝不替人下判断——那既不是这间草屋该做的事，也不是它能做的事。 */
  function closeDecision(kind, answers) {
    var aim = answers.aim || '';
    var worst = answers.worst || '';
    var nothing = answers.nothing || '';
    var long = answers.long || '';

    var lines = [];

    lines.push('【你写下的】');
    lines.push('想清楚的目标：' + shorten(aim));
    lines.push('最坏的结果：' + shorten(worst));
    lines.push('什么都不做：' + shorten(nothing));
    lines.push('十年后：' + shorten(long));
    lines.push('');

    // 只指出「你自己说过、但可能没并排看过」的矛盾
    var tensions = [];

    var worstHard = /^不/.test(worst.trim()) || /不能|受不了|承不住|撑不住/.test(worst);
    if (worstHard) {
      tensions.push('你写着最坏的结果承不住——那就不必再算它值多少了，这条已经出局。');
    }
    if (/错过|来不及|失去|更糟|变差|后悔/.test(nothing) && worstHard === false) {
      tensions.push('不动会更糟，而动的最坏结果你又说承得住——那这一步拖着的理由是什么？');
    }
    if (aim && long && long.length > 0) {
      var aimHit = overlap(aim, long);
      if (!aimHit) {
        tensions.push('你说的目标，和你说十年后会后悔的那一边，用的不是同一套话——它们真在一条线上吗？');
      }
    }
    if (/都|两|说不清/.test(long)) {
      tensions.push('十年后两个都后悔，那说明纠结的不在选项上，可能在这件事本身还不对。');
    }

    if (tensions.length) {
      lines.push('【摆在一处，看得出别扭的地方】');
      tensions.forEach(function (t) { lines.push('· ' + t); });
      lines.push('');
    }

    lines.push('【最后三问，你自问自答即可】');
    lines.push('一、若明天必须给出答复，你选哪个？先说出口，别改。');
    lines.push('二、选它以后，第一个具体动作是什么？落到能做的一件事上。');
    lines.push('三、若三个月后证明选错了，你打算怎么办？答得出，就说明这一步值得走。');

    return lines.join('\n');
  }

  // 两句里是否用了同一批实词（粗判，只为提示，不作依据）
  function overlap(a, b) {
    var stop = /[的了是在也和与或我你他她它这那就都还只不]/g;
    var words = function (s) {
      return s.replace(/[，。、；：！？\s]/g, ' ').replace(stop, '').split(' ').filter(function (w) {
        return w.length >= 2;
      });
    };
    var wa = words(a);
    var wb = words(b);
    for (var i = 0; i < wa.length; i++) {
      for (var j = 0; j < wb.length; j++) {
        if (wa[i].indexOf(wb[j]) >= 0 || wb[j].indexOf(wa[i]) >= 0) return true;
      }
    }
    return false;
  }

  function shorten(s, n) {
    var t = (s || '').replace(/\s+/g, ' ').trim();
    if (!t) return '（未写）';
    n = n || 42;
    return t.length > n ? t.slice(0, n) + '……' : t;
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

  /* 决策问答是「多轮的」：由调用方持有对话状态，
     每答一问调一次 step()，拿回下一句该说的话。 */
  function step(state, answer) {
    state = state || {};

    // 第一轮：拿题面，定类型，问第一问
    if (!state.kind) {
      var kind = kindOf(answer);
      var first = STEPS[0];
      return {
        state: { kind: kind.key, index: 0, answers: {}, n: 0 },
        text: '先接住这件事。' + kind.first + '\n\n' +
              leadOf(first, kind.key) + first.ask,
        done: false
      };
    }

    // 往后的轮次：把上一句答复存下，再问下一句
    var answers = state.answers || {};
    var cur = STEPS[state.index];
    answers[cur.id] = (answer || '').trim();

    var nk = (answer || '').trim()
      ? acknowledge(cur, answer)
      : '';
    var lead = nk ? nk + '\n\n' : '';

    var next = state.index + 1;

    // 承不住的底线：到此为止，不必再问——再问就是不尊重人
    if (cur.id === 'worst' && /^不/.test((answer || '').trim())) {
      return {
        state: { kind: state.kind, index: next, answers: answers, closed: true },
        text: lead + closeDecision({ key: state.kind }, answers),
        done: true
      };
    }

    if (next >= STEPS.length) {
      return {
        state: { kind: state.kind, index: next, answers: answers, closed: true },
        text: lead + closeDecision({ key: state.kind }, answers),
        done: true
      };
    }

    var s = STEPS[next];
    return {
      state: { kind: state.kind, index: next, answers: answers },
      text: lead + leadOf(s, state.kind) + s.ask +
            (s.hint ? '\n\n（' + s.hint + '）' : ''),
      done: false
    };
  }

  function leadOf(s, kind) {
    return (s.lead && s.lead[kind]) ? s.lead[kind] + '\n\n' : '';
  }

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

  return { step: step, draft: draft, generate: generate };
})();
