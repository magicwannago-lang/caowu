/* 小狐 Live2D 动态宠物层
   依赖（CDN 预编译，无构建）：PixiJS 6 + Live2D Cubism Core + pixi-live2d-display 0.4
   对外暴露 window.FoxLive2D，供 fox.js 的状态机 / TTS 调用。

   2026-09-28：管线接入草屋，但默认关闭——不加载模型、不露人形，
   页面仍是真实白狐 PNG。小白狐模型到位后只需改本文件顶部两行：
     ENABLED = true;
     MODEL_URL = '模型的 model3.json 地址';

   2026-09-29：并入「状态映射」STATE_MAP（IB/小白狐智脑_fox-live2d状态映射.js），
   支持 idle/talk/thinking/wave/sleep/stretch/yawn/happy 八态。
   映射里的 expression/motion 名为占位名，按
     精确名 → 关键词命中 → 兜底分组 → 放弃
   的顺序解析，名称对不上也不报错，只是该状态少一层表现；
   模型到位后控制台跑 FoxLive2D.__debug.listAssets() 看真实清单再核对。

   2026-09-29（续）：KizuneMiko 模型入仓并启用。该模型实况（kizuneMikoPsd.model3.json）：
   - 无任何 motion 动作文件——wave/think/stretch/yawn/happy/sleep 的肢体表现缺位，
     fox.js 状态序列照常运转，等日后补 motion3 动作包即自动生效（关键词解析已就位）；
   - 6 个表情里只有 angry 是脸部表情；kuwa/pangci/qunzi/yifu/qunziheyifu 是
     裤袜/胖次/裙子/衣服的「衣物开关」（PSD 导出口径），绝不自动触发；
   - 眼睛只有一个 ParamEyeLOpen（无 R 参数，双眼同控）；
   - 尾巴参数是 Param3（cdi 名「摇动 尾巴」），id 不含 tail，已显式登记；
     物理只随身体角度输出，而模型无动作驱动身体角度，故 idle 时手动缓摇。
*/
(function () {
  'use strict';

  /* ============================================================
   * 【上线开关】小白狐模型放 assets/fox/live2d/，
   * 到位后把 ENABLED 改 true，并核对 MODEL_URL 文件名
   *
   * 2026-09-30：按用户要求切回小白狐——ENABLED 置 false，
   * 页面恢复真实白狐 PNG。狐巫女（KizuneMiko）模型文件保留在
   * assets/fox/live2d/ 作备份（已随仓库 push），日后想用人形改回 true 即可。
   * ============================================================ */
  var ENABLED = false;
  var MODEL_URL = 'assets/fox/live2d/kizuneMikoPsd.model3.json';

  var CANVAS_W = 400;
  var CANVAS_H = 400;
  var FIT_H = 330;            // 模型在 canvas 内的目标高度（内部像素）；页面显示大小由 CSS 决定
  var LOAD_TIMEOUT = 25000;   // 模型加载超时即回退 PNG

  // 参数 id（KizuneMiko：眼睛只有 L 一个参数，双眼同控；无 R 参数）
  var PARAM = {
    eyeOpen: 'ParamEyeLOpen',
    mouthOpenY: 'ParamMouthOpenY'
  };

  /* ============================================================
   * 状态映射：每个状态 → expression(表情) / motion(动作) / duration / 说明
   * duration 仅作口径记录：状态转移由 fox.js 状态机统一掌握，
   *   Infinity 常驻、'auto' 由调用方（思考结束/回复到达）退出、
   *   数字毫秒由 fox.js 的 stateTimer 定时器控制，本层不自行回 idle。
   * KizuneMiko 实况：无 motion；表情除 angry 外都是衣物开关。
   *   故 expression 一律置空（[]），motion 占位名保留——
   *   日后补动作/表情包时把真实名填回这里，解析器（精确名→关键词）已就位。
   * ============================================================ */
  var STATE_MAP = {
    // ---------- 常规 ----------
    idle: {
      expression: [],           // 模型默认脸即正常表情
      motion: ['idle'],         // 模型无动作；待机靠眨眼+尾巴缓摇
      duration: Infinity,
      desc: '待机（眨眼+尾巴慢摆）'
    },

    talk: {
      expression: [],
      motion: ['talk'],         // 无动作；嘴型随 TTS boundary 动
      duration: 5000,           // 实际以 TTS 播完为准
      desc: '对话中（口型跟随语音）'
    },

    thinking: {
      expression: [],           // 想要 serious/think 表情，本模型未提供
      motion: ['thinking'],     // 低头思考动作未提供
      duration: 'auto',         // 直到回复返回才退出
      desc: '思考中（工具调用/等待回复）'
    },

    // ---------- 打招呼 ----------
    wave: {
      expression: [],           // 想要 smile 表情，本模型未提供
      motion: ['wave'],         // 挥手动作未提供
      duration: 1500,
      desc: '挥手打招呼'
    },

    // ---------- 睡眠 ----------
    sleep: {
      expression: [],           // 想要 sleepy 表情，本模型未提供
      motion: ['sleep'],        // 睡觉动作未提供；闭眼由 onFrame 注入
      duration: Infinity,       // 持续到唤醒
      desc: '睡觉'
    },

    // ---------- 刚醒 / 放松 ----------
    stretch: {
      expression: [],
      motion: ['stretch'],      // 伸懒腰动作未提供
      duration: 2500,
      desc: '伸懒腰（像猫）'
    },

    yawn: {
      expression: [],
      motion: ['yawn'],         // 打哈欠动作未提供
      duration: 2000,
      desc: '打哈欠'
    },

    // ---------- 情绪 ----------
    happy: {
      expression: [],           // 想要 smile 表情，本模型未提供
      motion: ['happy'],        // 开心/跳跃动作未提供
      duration: 2000,
      desc: '开心'
    }
  };

  // 表情占位名 → 关键词（精确名匹配不到时，用它在真实表情名里找）
  var EXPRESSION_KEYWORDS = {
    normal: /normal|default|putong|默认/i,
    smile: /smile|happy|laugh|xiao|笑/i,
    sleepy: /sleep|sleepy|tired|kun|困|睡/i,
    serious: /serious|think|renzhen|认真|思/i
  };

  // 动作占位名 → 关键词（在动作分组名 / motion3 文件名里找）
  var MOTION_KEYWORDS = {
    idle: /idle|stand|daiji|待机/i,
    talk: /talk|speak|shuohua|说话/i,
    thinking: /think|thinking|sikao|思考/i,
    wave: /wave|hello|greet|hand|zhaoshou|huishou|挥手/i,
    sleep: /sleep|sleeping|rest|shuijiao|睡觉/i,
    stretch: /stretch|lanyangao|伸懒/i,
    yawn: /yawn|haqian|哈欠/i,
    happy: /happy|joy|laugh|kaixin|开心/i
  };

  // 挥手动作解析顺序：WAVE_MOTION 显式指定 → 分组名/文件名命中关键词 → 兜底分组
  // 小白狐模型若有 wave 分组，关键词会自动命中；也可把这里改为 { group: 'wave', index: 0 }
  var WAVE_MOTION = null;
  var WAVE_FALLBACK_GROUPS = ['TapBody', 'Tap'];

  var foxEl = document.getElementById('fox');

  var app = null;
  var model = null;
  var coreModel = null;
  var ready = false;
  var state = 'idle';
  // 尾巴参数：KizuneMiko 是 Param3（cdi 名「摇动 尾巴」），id 不含 tail 关键词，
  // 显式登记；下面的 /tail/ 扫描再兜底其他模型
  var tailParams = ['Param3'];
  var blinkTimer = null;
  var blinkStart = 0;
  var blinkUntil = 0;
  var BLINK_MS = 200;         // 单次眨眼时长

  function startBlink(ms) {
    blinkStart = performance.now();
    blinkUntil = blinkStart + (ms || BLINK_MS);
  }
  var speaking = false;
  var mouthValue = 0;
  var mouthTimer = null;

  /* ---------------- 降级：恢复显示 PNG 层 ---------------- */
  function fallback(reason) {
    try {
      foxEl.classList.remove('mode-live2d');
      foxEl.classList.add('mode-png');
      // PNG 层本就在文档中；确保当前状态对应的那张可见
      if (window.FoxPNGEnsure) FoxPNGEnsure(state);
    } catch (e) { /* ignore */ }
    ready = false;
    if (window.console) console.warn('[Live2D] 回退静态 PNG：', reason || '未知原因');
    return false;
  }

  function setParam(id, v) {
    if (!coreModel) return;
    try {
      coreModel.setParameterValueById(id, v);
    } catch (e) { /* 该模型无此参数，跳过 */ }
  }

  /* ---------------- 初始化：建 PIXI 应用 → 加载模型 → 接线 ---------------- */
  function init() {
    if (!ENABLED) return Promise.resolve(false); // 开关未开：不加载、不露人形
    var canvas;
    try {
      if (!window.PIXI || !PIXI.live2d || !PIXI.live2d.Live2DModel || !window.Live2DCubismCore) {
        return Promise.resolve(fallback('CDN SDK 未加载成功'));
      }

      canvas = document.getElementById('live2d');
      app = new PIXI.Application({
        view: canvas,
        width: CANVAS_W,
        height: CANVAS_H,
        backgroundAlpha: 0,    // 透明背景
        antialias: true
      });

      var loadPromise = PIXI.live2d.Live2DModel.from(MODEL_URL, {
        autoUpdate: true,      // 模型随 PIXI Ticker 自动刷新
        autoInteract: false    // 不用库自带的 canvas 局部追踪，自己在 document 上做全页跟随
      });

      return Promise.race([
        loadPromise,
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('模型加载超时')); }, LOAD_TIMEOUT);
        })
      ]).then(function (m) {
        var im = m.internalModel;
        model = m;
        coreModel = im.coreModel;
        window.__pldModel = m;  // 调试句柄（控制台手动试动作/参数用）

        im.eyeBlink = null;    // 关掉 SDK 自带的定时眨眼，改用下方 3–5s 随机眨眼

        // 尺寸适配：按高度等比缩放，锚点居中放到 canvas 中心
        var scale = FIT_H / im.originalHeight;
        m.scale.set(scale);
        m.anchor.set(0.5, 0.5);
        m.position.set(CANVAS_W / 2, CANVAS_H / 2);
        app.stage.addChild(m);

        // 检测尾巴参数（id 含 tail 即认为有；没有 → 留空，待机摇尾跳过）
        try {
          var count = coreModel.getParameterCount();
          for (var i = 0; i < count; i++) {
            var pid = coreModel.getParameterIdAtIndex(i);
            if (/tail/i.test(pid)) tailParams.push(pid);
          }
        } catch (e) { /* 扫描失败：保留显式登记的尾巴参数 */ }

        // 睡眠时拦截自动待机动作（否则睡着还在挥手）
        patchIdleDuringSleep(im.motionManager);

        im.on('beforeModelUpdate', onFrame);           // 动作/物理之后、coreModel.update 之前
        document.addEventListener('pointermove', onPointerMove);

        foxEl.classList.add('mode-live2d');
        foxEl.classList.remove('mode-png');
        ready = true;
        scheduleBlink();
        setState(state);
        return true;
      }).catch(function (err) {
        return fallback(err && err.message);
      });
    } catch (err) {
      return Promise.resolve(fallback(err && err.message));
    }
  }

  /* ---------------- 鼠标跟随：头和视线 ---------------- */
  function onPointerMove(e) {
    if (!ready || !model || state === 'sleep') return;
    model.focus(e.clientX, e.clientY); // pixi-live2d-display 内部换算为模型坐标并驱动视线/头部
  }

  /* ---------------- 随机眨眼：3–5s 一次 ---------------- */
  function scheduleBlink() {
    clearTimeout(blinkTimer);
    var delay = 3000 + Math.random() * 2000;
    blinkTimer = setTimeout(function () {
      if (state !== 'sleep') startBlink();
      scheduleBlink();
    }, delay);
  }

  /* ---------------- 每帧参数注入 ---------------- */
  function onFrame() {
    var now = performance.now();

    // 眼睛：睡眠闭眼；眨眼进行中走 1→0→1 三角波（单参数，双眼同控）
    if (state === 'sleep') {
      setParam(PARAM.eyeOpen, 0);
    } else if (blinkUntil > now) {
      var t = 1 - (blinkUntil - now) / (blinkUntil - blinkStart);
      var eye = t < 0.5 ? 1 - t * 2 : (t - 0.5) * 2; // 1→0→1
      setParam(PARAM.eyeOpen, eye);
    }

    // 嘴：TTS 说话时张合，说完闭嘴
    setParam(PARAM.mouthOpenY, speaking ? mouthValue : 0);

    // 待机尾巴缓慢摇摆（有尾巴参数才驱动，没有就跳过）
    if (tailParams.length && state === 'idle') {
      for (var i = 0; i < tailParams.length; i++) {
        setParam(tailParams[i], Math.sin(now / 850 - i * 0.9) * 0.5);
      }
    }
  }

  /* ---------------- TTS 嘴型（由 fox.js 的 boundary/end 事件调用） ---------------- */
  function mouthStart() {
    if (!ready) return;
    speaking = true;
    mouthValue = 0.6;
    clearInterval(mouthTimer);
    mouthTimer = setInterval(function () {
      // 两次 boundary 之间周期性张合；boundary 事件到达时立即拉满
      mouthValue = mouthValue > 0.5
        ? 0.15 + Math.random() * 0.2
        : 0.55 + Math.random() * 0.4;
    }, 140);
  }

  function mouthPulse() { // utterance.onboundary
    if (speaking) mouthValue = 1;
  }

  function mouthStop() {  // utterance.onend / onerror / 手动静音
    clearInterval(mouthTimer);
    mouthTimer = null;
    speaking = false;
    mouthValue = 0;
  }

  /* ---------------- 状态映射：fox.js 状态机保持唯一转移权，这里只管模型表现 ---------------- */
  function setState(next) {
    state = next;
    if (!ready) return;

    var im = model.internalModel;
    var mm = im.motionManager;

    if (next === 'sleep') {
      im._wasSleeping = true;
      mm.stopAllMotions();                                 // 停掉挥手/待机动作
      im.focusController.focus(0, 0, true);                // 视线回正
      return;                                              // 闭眼/抱臂由 onFrame 注入
    }

    // 从睡眠醒来：补一个待机动作（睡眠期间自动待机被拦截了）；
    // KizuneMiko 无动作组，检查通过才播，避免 model.motion(undefined/空组) 抛错
    if (im._wasSleeping) {
      im._wasSleeping = false;
      var idleGroup = mm.groups && mm.groups.idle;
      var idleDefs = idleGroup && mm.definitions && mm.definitions[idleGroup];
      if (idleDefs && idleDefs.length) {
        try { model.motion(idleGroup); } catch (e) { /* ignore */ }
      }
    }

    var cfg = STATE_MAP[next];
    if (!cfg) return;

    // 表情：模型没有表情列表时静默跳过
    applyExpression(cfg.expression);

    // 动作：idle 交给 motionManager 自动随机；其余按映射找
    if (next !== 'idle') playMappedMotion(next, cfg.motion);
  }

  function patchIdleDuringSleep(mm) {
    var orig = mm.startRandomMotion.bind(mm);
    mm.startRandomMotion = function (group, priority) {
      if (state === 'sleep' && group === mm.groups.idle) {
        return Promise.resolve(false); // 睡眠中不续待机动作
      }
      return orig(group, priority);
    };
  }

  /* ---------------- 表情：精确名 → 关键词；找不到放弃 ---------------- */
  function applyExpression(candidates) {
    try {
      var em = model.internalModel.expressionManager;
      if (!em || !em.definitions || !em.definitions.length) return;

      for (var c = 0; c < candidates.length; c++) {
        var key = candidates[c];
        var rx = EXPRESSION_KEYWORDS[key] || new RegExp(key, 'i');

        // 1) 精确名
        for (var i = 0; i < em.definitions.length; i++) {
          var nm = em.definitions[i].Name || em.definitions[i].name || '';
          if (nm.toLowerCase() === key.toLowerCase()) return model.expression(i);
        }
        // 2) 关键词
        for (i = 0; i < em.definitions.length; i++) {
          nm = em.definitions[i].Name || em.definitions[i].name || '';
          if (rx.test(nm)) return model.expression(i);
        }
      }
    } catch (e) { /* 表情切换失败不影响其他功能 */ }
  }

  /* ---------------- 动作：显式指定 → 精确分组名 → 关键词 → 兜底分组 → 任意非 Idle（仅 wave） ---------------- */
  function playMappedMotion(stateName, candidates) {
    try {
      var mm = model.internalModel.motionManager;
      var defs = mm.definitions || {};
      var groups = Object.keys(defs);

      // 0) 显式指定的挥手动作
      if (stateName === 'wave' && WAVE_MOTION
          && defs[WAVE_MOTION.group] && defs[WAVE_MOTION.group][WAVE_MOTION.index]) {
        return model.motion(WAVE_MOTION.group, WAVE_MOTION.index);
      }

      // 1) 精确分组名 / 关键词命中
      var hit = resolveMotionGroup(candidates);
      if (hit) return model.motion(hit.group, hit.index);

      // 2) 挥手专用：预设分组顺序取第一个动作
      if (stateName === 'wave') {
        for (var k = 0; k < WAVE_FALLBACK_GROUPS.length; k++) {
          var fg = WAVE_FALLBACK_GROUPS[k];
          if (defs[fg] && defs[fg].length) return model.motion(fg, 0);
        }
        // 3) 任意非 Idle 分组第一个
        for (var j = 0; j < groups.length; j++) {
          if (!/idle/i.test(groups[j]) && defs[groups[j]].length) {
            return model.motion(groups[j], 0);
          }
        }
      }
    } catch (e) { /* 动作播放失败不影响其他功能 */ }
  }

  function resolveMotionGroup(candidates) {
    var defs = model.internalModel.motionManager.definitions || {};
    var groups = Object.keys(defs);

    for (var c = 0; c < candidates.length; c++) {
      var key = candidates[c];
      var rx = MOTION_KEYWORDS[key] || new RegExp(key, 'i');

      // 精确分组名
      for (var g = 0; g < groups.length; g++) {
        if (groups[g].toLowerCase() === key.toLowerCase()) return { group: groups[g], index: 0 };
      }
      // 分组名 / 文件名命中关键词
      for (g = 0; g < groups.length; g++) {
        if (rx.test(groups[g])) return { group: groups[g], index: 0 };
        var list = defs[groups[g]] || [];
        for (var i = 0; i < list.length; i++) {
          var file = list[i].File || list[i].file || '';
          if (rx.test(file)) return { group: groups[g], index: i };
        }
      }
    }
    return null;
  }

  function debugForceBlink(ms) {
    if (state !== 'sleep') startBlink(ms);
  }

  // 模型真实动作/表情清单（模型到位后核对占位名用）
  function debugListAssets() {
    if (!ready) { console.warn('[FoxLive2D] 模型未就绪'); return null; }
    var defs = model.internalModel.motionManager.definitions || {};
    var out = { motions: {}, expressions: [] };
    Object.keys(defs).forEach(function (g) {
      out.motions[g] = defs[g].map(function (d) { return d.File || d.file; });
    });
    var em = model.internalModel.expressionManager;
    if (em && em.definitions) {
      out.expressions = em.definitions.map(function (d) { return d.Name || d.name; });
    }
    console.log('[FoxLive2D] 模型真实清单（对照 STATE_MAP 核对）：', out);
    return out;
  }

  window.FoxLive2D = {
    init: init,
    isReady: function () { return ready; },
    setState: setState,
    mouthStart: mouthStart,
    mouthPulse: mouthPulse,
    mouthStop: mouthStop,
    __debug: {
      forceBlink: debugForceBlink,
      listAssets: debugListAssets
    }
  };
})();
