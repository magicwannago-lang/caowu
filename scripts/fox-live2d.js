/* 小狐 Live2D 动态宠物层
   依赖（CDN 预编译，无构建）：PixiJS 6 + Live2D Cubism Core + pixi-live2d-display 0.4
   对外暴露 window.FoxLive2D，供 fox.js 的状态机 / TTS 调用。

   2026-09-28：管线接入草屋，但默认关闭——不加载模型、不露人形，
   页面仍是真实白狐 PNG。小白狐模型到位后只需改本文件顶部两行：
     ENABLED = true;
     MODEL_URL = '模型的 model3.json 地址';
*/
(function () {
  'use strict';

  /* ============================================================
   * 【上线开关】小白狐模型到位后把 ENABLED 改 true，并指向模型
   * ============================================================ */
  var ENABLED = false;
  var MODEL_URL = 'assets/fox/live2d/xiaohu.model3.json';

  var CANVAS_W = 400;
  var CANVAS_H = 400;
  var FIT_H = 330;            // 模型在 canvas 内的目标高度（内部像素）；页面显示大小由 CSS 决定
  var LOAD_TIMEOUT = 25000;   // 模型加载超时即回退 PNG

  // Cubism 4 标准参数 id（换模型若有出入，对照新模型参数表改这里）
  var PARAM = {
    eyeLOpen: 'ParamEyeLOpen',
    eyeROpen: 'ParamEyeROpen',
    mouthOpenY: 'ParamMouthOpenY'
  };

  // 挥手动作解析顺序：WAVE_MOTION 显式指定 → 分组名/文件名命中关键词 → 兜底分组
  // 小白狐模型若有 wave 分组，把这里改为 { group: 'wave', index: 0 } 即可；
  // 关键词 / 兜底分组见下方 WAVE_KEYWORDS、WAVE_FALLBACK_GROUPS
  var WAVE_MOTION = null;
  var WAVE_KEYWORDS = /wave|hello|greet|hand|zhaoshou|huishou/i;
  var WAVE_FALLBACK_GROUPS = ['TapBody', 'Tap'];

  var foxEl = document.getElementById('fox');

  var app = null;
  var model = null;
  var coreModel = null;
  var ready = false;
  var state = 'idle';
  var tailParams = [];        // 模型自带的尾巴参数 id；为空 → 待机摇尾自动跳过
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
        } catch (e) { tailParams = []; }

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

    // 眼睛：睡眠闭眼；眨眼进行中走 1→0→1 三角波
    if (state === 'sleep') {
      setParam(PARAM.eyeLOpen, 0);
      setParam(PARAM.eyeROpen, 0);
      // 固定抱臂的安睡姿态，避免 stopAllMotions 时定格在挥手等动作中途
      setParam('ParamArmLA', 0.5);
      setParam('ParamArmRA', 0.5);
      setParam('ParamArmLB', 0.5);
      setParam('ParamArmRB', 0.5);
    } else if (blinkUntil > now) {
      var t = 1 - (blinkUntil - now) / (blinkUntil - blinkStart);
      var eye = t < 0.5 ? 1 - t * 2 : (t - 0.5) * 2; // 1→0→1
      setParam(PARAM.eyeLOpen, eye);
      setParam(PARAM.eyeROpen, eye);
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

  /* ---------------- 状态映射（fox.js 状态机保持不变，这里只管模型表现） ---------------- */
  function setState(next) {
    state = next;
    if (!ready) return;

    var mm = model.internalModel.motionManager;

    if (next === 'wave') {
      playWave();
      return;
    }

    if (next === 'sleep') {
      model.internalModel._wasSleeping = true;
      mm.stopAllMotions();                               // 停掉挥手/待机动作
      model.internalModel.focusController.focus(0, 0, true); // 视线回正
      return;
    }

    // 从睡眠醒来：补一个待机动作（睡眠期间自动待机被拦截了）
    if (model.internalModel._wasSleeping) {
      model.internalModel._wasSleeping = false;
      model.motion(mm.groups.idle);
    }

    // idle / talk：正常表情 + 默认姿势，无需额外动作
    // TODO(stretch/yawn)：小白狐模型若提供伸懒腰/打哈欠 motion，
    //   在这里 model.motion(group, index) 接入即可
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

  /* ---------------- 挥手动作：按关键词找，找不到按预设分组兜底 ---------------- */
  function playWave() {
    try {
      var defs = model.internalModel.motionManager.definitions || {};
      var groups = Object.keys(defs);

      // 0) 显式指定的挥手动作
      if (WAVE_MOTION && defs[WAVE_MOTION.group] && defs[WAVE_MOTION.group][WAVE_MOTION.index]) {
        return model.motion(WAVE_MOTION.group, WAVE_MOTION.index);
      }

      // 1) 分组名 / 文件名命中关键词
      for (var g = 0; g < groups.length; g++) {
        var group = groups[g];
        if (WAVE_KEYWORDS.test(group)) return model.motion(group);
        var list = defs[group] || [];
        for (var i = 0; i < list.length; i++) {
          var file = list[i].File || list[i].file || '';
          if (WAVE_KEYWORDS.test(file)) return model.motion(group, i);
        }
      }

      // 2) 预设分组顺序，取第一个动作
      for (var k = 0; k < WAVE_FALLBACK_GROUPS.length; k++) {
        var fg = WAVE_FALLBACK_GROUPS[k];
        if (defs[fg] && defs[fg].length) return model.motion(fg, 0);
      }

      // 3) 兜底：任意非 Idle 分组第一个
      for (var j = 0; j < groups.length; j++) {
        if (groups[j] !== 'Idle' && defs[groups[j]].length) {
          return model.motion(groups[j], 0);
        }
      }
    } catch (e) { /* 挥手失败不影响其他功能 */ }
  }

  function debugForceBlink(ms) {
    if (state !== 'sleep') startBlink(ms);
  }

  window.FoxLive2D = {
    init: init,
    isReady: function () { return ready; },
    setState: setState,
    mouthStart: mouthStart,
    mouthPulse: mouthPulse,
    mouthStop: mouthStop,
    __debug: { forceBlink: debugForceBlink }
  };
})();
