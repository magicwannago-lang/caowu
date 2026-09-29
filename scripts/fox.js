/* 小狐：常驻草屋右侧的九尾白狐。对话走衡几 Worker /fox/chat 路由，
   工具（天气/提醒）与 TTS 在浏览器端执行。 */
(function () {
  'use strict';

  var API_URL = 'https://hengji.sevencolor.space/fox/chat';

  var fox = document.getElementById('fox');
  var imgs = {
    idle: document.getElementById('fox-idle'),
    wave: document.getElementById('fox-wave'),
    sleep: document.getElementById('fox-sleep')
  };
  var panel = document.getElementById('panel');
  var messagesEl = document.getElementById('messages');
  var input = document.getElementById('input');
  var soundBtn = document.getElementById('sound-btn');
  var closeBtn = document.getElementById('close-btn');

  var L2D = window.FoxLive2D;  // Live2D 动态层（默认未启用；故障时内部自动回退 PNG）
  // idle | wave | sleep | talk | thinking | stretch | yawn | happy
  // 后五态只有 Live2D 表现；PNG 层无对应图，降级显示 idle
  var state = 'idle';
  var stateTimer = null;       // 临时状态（wave/stretch/yawn/happy/启动序列）的回位定时器
  var idleWatchTimer = null;   // 长时间无操作计时
  var talkReturnState = 'idle'; // 说完话后恢复的状态
  var muted = false;
  var busy = false;
  var messages = [];           // 完整对话历史（含 tool_use / tool_result）

  /* ---------------- 素材兜底：缺图时换内联 SVG（若有 FoxArt）或留空 ---------------- */
  Object.keys(imgs).forEach(function (name) {
    imgs[name].addEventListener('error', function onError() {
      imgs[name].removeEventListener('error', onError);
      if (window.FoxArt) imgs[name].src = FoxArt.dataUri(name);
    });
  });

  /* ---------------- 状态切换：同时驱动 Live2D 层与 PNG 层 ---------------- */
  function setState(next) {
    state = next;
    if (L2D) L2D.setState(next); // 未启用/未就绪时为 no-op
    syncPNG(next);
    fox.classList.toggle('sleep', next === 'sleep');
    fox.classList.toggle('float', next === 'idle');
    fox.classList.toggle('wave', next === 'wave');
  }

  // PNG 只有 idle/wave/sleep 三图：talk 按「说完要回的状态」显示，
  // thinking/stretch/yawn/happy 无图，诚实降级为 idle
  function syncPNG(s) {
    var pngState;
    if (s === 'talk') pngState = talkReturnState;
    else if (s === 'idle' || s === 'wave' || s === 'sleep') pngState = s;
    else pngState = 'idle';
    Object.keys(imgs).forEach(function (name) {
      imgs[name].classList.toggle('active', name === pngState);
    });
  }

  // Live2D 降级时由 fox-live2d.js 调用，确保 PNG 层姿态正确
  window.FoxPNGEnsure = syncPNG;

  // 临时状态：播 ms 毫秒后自动回 idle（仅当仍停在该状态）
  function temporaryState(next, ms) {
    clearTimeout(stateTimer);
    setState(next);
    stateTimer = setTimeout(function () {
      if (state === next) setState('idle');
    }, ms);
  }

  function triggerWave() {
    // 睡着或正在想事时不打断（面板仍照常开关）
    if (state === 'sleep' || busy) return;
    temporaryState('wave', 1500);
  }

  function toggleSleep() {
    clearTimeout(stateTimer);
    if (state === 'sleep') {
      // 唤醒流程：伸懒腰(2.5s) → 打哈欠(2s) → idle
      setState('stretch');
      stateTimer = setTimeout(function () {
        if (state !== 'stretch') return; // 序列中又被哄睡则中止
        setState('yawn');
        stateTimer = setTimeout(function () {
          if (state === 'yawn') setState('idle');
        }, 2000);
      }, 2500);
    } else {
      setState('sleep');
    }
  }

  /* ---------------- 面板开关 ---------------- */
  function openPanel() {
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
    input.focus();
  }

  function closePanel() {
    panel.classList.add('hidden');
    panel.setAttribute('aria-hidden', 'true');
  }

  function togglePanel() {
    if (panel.classList.contains('hidden')) openPanel();
    else closePanel();
  }

  /* ---------------- TTS ---------------- */
  function pickZhVoice() {
    var voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    for (var i = 0; i < voices.length; i++) {
      if (voices[i].lang === 'zh-CN') return voices[i];
    }
    return null;
  }

  function speak(text) {
    if (muted || !text || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.pitch = 0.8;
    u.rate = 0.95;
    var v = pickZhVoice();
    if (v) u.voice = v;

    // 嘴型联动：开始 → talk 状态；boundary → 张嘴；结束/出错 → 闭嘴并恢复原状态
    u.onstart = function () {
      if (!L2D || !L2D.isReady()) return;
      talkReturnState = state === 'sleep' ? 'sleep' : 'idle';
      L2D.mouthStart();
      setState('talk');
    };
    u.onboundary = function () {
      if (L2D) L2D.mouthPulse();
    };
    var onDone = function () {
      if (!L2D) return;
      L2D.mouthStop();
      if (state === 'talk') setState(talkReturnState);
    };
    u.onend = onDone;
    u.onerror = onDone;

    speechSynthesis.speak(u);
  }

  soundBtn.addEventListener('click', function () {
    muted = !muted;
    soundBtn.classList.toggle('muted', muted);
    if (muted && 'speechSynthesis' in window) speechSynthesis.cancel();
    if (muted && L2D) { // 静音时确保嘴闭上、退出 talk 状态
      L2D.mouthStop();
      if (state === 'talk') setState(talkReturnState);
    }
  });

  if ('speechSynthesis' in window) {
    speechSynthesis.onvoiceschanged = function () {}; // 触发语音列表加载
  }

  /* ---------------- 消息气泡 ---------------- */
  function addBubble(kind, text) {
    var div = document.createElement('div');
    div.className = 'bubble ' + kind;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  /* ---------------- 工具：天气 ---------------- */
  var WMO_CODES = {
    0: '晴', 1: '大致晴朗', 2: '局部多云', 3: '阴',
    45: '雾', 48: '冻雾',
    51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
    56: '冻毛毛雨', 57: '强冻毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨',
    66: '冻雨', 67: '强冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
    80: '小阵雨', 81: '阵雨', 82: '强阵雨',
    85: '小阵雪', 86: '大阵雪',
    95: '雷暴', 96: '雷暴伴小冰雹', 99: '雷暴伴大冰雹'
  };

  function getWeather(city) {
    var geoUrl = 'https://geocoding-api.open-meteo.com/v1/search?name='
      + encodeURIComponent(city) + '&count=1&language=zh';
    return fetch(geoUrl)
      .then(function (r) { return r.json(); })
      .then(function (geo) {
        var loc = geo.results && geo.results[0];
        if (!loc) return { ok: false, error: '未找到该城市' };
        var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.latitude
          + '&longitude=' + loc.longitude + '&current=temperature_2m,weathercode';
        return fetch(url)
          .then(function (r) { return r.json(); })
          .then(function (fc) {
            var code = fc.current.weathercode;
            return {
              ok: true,
              city: loc.name,
              temperature: fc.current.temperature_2m,
              description: WMO_CODES[code] || '未知天气'
            };
          });
      });
  }

  /* ---------------- 工具：提醒 ---------------- */
  function setReminder(minutes, message) {
    var ms = Math.max(0, Number(minutes)) * 60000;
    function schedule() {
      setTimeout(function () {
        new Notification('小狐提醒', { body: message });
        // 先开心(2s)再开口，让喜悦有个起势；静音时 happy 到时自回 idle
        temporaryState('happy', 2000);
        setTimeout(function () { speak(message); }, 700);
      }, ms);
    }
    if (!('Notification' in window)) {
      return Promise.resolve({ ok: false, error: '当前浏览器不支持通知' });
    }
    if (Notification.permission === 'granted') {
      schedule();
    } else {
      Notification.requestPermission().then(function (perm) {
        if (perm === 'granted') schedule();
      });
    }
    return Promise.resolve({
      ok: true,
      remind_in_minutes: minutes,
      remind_at: new Date(Date.now() + ms).toLocaleTimeString('zh-CN'),
      note: '若用户未授权通知权限，可能无法弹出提醒'
    });
  }

  function runTool(name, input) {
    if (name === 'get_weather') return getWeather(input.city);
    if (name === 'set_reminder') return setReminder(input.minutes, input.message);
    return Promise.resolve({ ok: false, error: '未知工具：' + name });
  }

  // 夸奖关键词（轻量启发式，只决定要不要先开心一下；判错也不碍事）
  var PRAISE_WORDS = /谢谢|多谢|辛苦了|好棒|真棒|太棒|厉害|聪明|真乖|好乖|喜欢|真好|点赞|赞一个/;

  /* ---------------- 对话主循环 ---------------- */
  function sendMessage(text) {
    if (busy || !text.trim()) return;
    busy = true;
    var praised = PRAISE_WORDS.test(text);
    addBubble('user', text);
    messages.push({ role: 'user', content: text });
    var loading = addBubble('sys', '小狐在想…');

    // 进入思考：停掉招手等临时状态，直到回复到达
    clearTimeout(stateTimer);
    setState('thinking');

    function finish(err) {
      messagesEl.removeChild(loading);
      busy = false;
      if (err) {
        addBubble('error', err);
        if (state === 'thinking') setState('idle'); // 出错也要从思考中退出
      }
      input.focus();
    }

    function step() {
      return fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: messages })
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error((data.error && data.error.message) || data.error || '请求失败');
          return data;
        });
      }).then(function (data) {
        // assistant 整包入历史，保留其中的 tool_use 块
        messages.push({ role: 'assistant', content: data.content });

        if (data.stop_reason === 'tool_use') {
          var results = [];
          var jobs = data.content
            .filter(function (b) { return b.type === 'tool_use'; })
            .map(function (block) {
              loading.textContent = toolHint(block.name);
              return runTool(block.name, block.input).then(
                function (r) {
                  results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(r) });
                },
                function (e) {
                  results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify({ ok: false, error: String(e) }), is_error: true });
                }
              );
            });
          return Promise.all(jobs).then(function () {
            messages.push({ role: 'user', content: results });
            return step(); // 继续直到 final text
          });
        }

        var reply = data.content
          .filter(function (b) { return b.type === 'text'; })
          .map(function (b) { return b.text; })
          .join('')
          .trim();
        // 回复到达：退出思考。被夸奖先开心一下再起语；若期间睡着了就不打扰
        if (state === 'thinking') {
          if (praised) temporaryState('happy', 2000);
          else setState('idle');
        }
        if (reply) {
          addBubble('assistant', reply);
          if (praised) setTimeout(function () { speak(reply); }, 1200);
          else speak(reply);
        }
      });
    }

    step().then(function () { finish(); }, function (err) { finish(err.message); });
  }

  function toolHint(name) {
    return name === 'get_weather' ? '小狐看了看天色…' : '小狐记下了…';
  }

  // 就地简聊：由入口气泡的小字按钮调用
  window.FoxQuickChat = function () {
    if (panel.classList.contains('hidden')) openPanel();
  };

  /* ---------------- 事件绑定 ---------------- */
  fox.addEventListener('click', function () {
    triggerWave();
    // 点击狐巫女：浮出入口气泡（进入 MOON 智脑 / 就地简聊）
    if (window.FoxEntry) FoxEntry.show();
  });

  fox.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    toggleSleep();
  });

  closeBtn.addEventListener('click', closePanel);

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var text = input.value;
      input.value = '';
      sendMessage(text);
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.classList.contains('hidden')) closePanel();
  });

  // 启动打招呼：1.5s 后挥手(1.5s) → 打哈欠(2s) → idle
  setTimeout(function () {
    if (state !== 'idle') return;
    setState('wave');
    stateTimer = setTimeout(function () {
      if (state !== 'wave') return; // 期间被哄睡/开始对话则中止
      setState('yawn');
      stateTimer = setTimeout(function () {
        if (state === 'yawn') setState('idle');
      }, 2000);
    }, 1500);
  }, 1500);

  // 长时间无操作：30s 后有一半概率伸懒腰，随后继续观察
  function armIdleWatch() {
    clearTimeout(idleWatchTimer);
    idleWatchTimer = setTimeout(function () {
      if (state === 'idle' && !busy && Math.random() > 0.5) {
        temporaryState('stretch', 2500);
      }
      armIdleWatch();
    }, 30000);
  }
  ['mousemove', 'keydown', 'touchstart'].forEach(function (ev) {
    document.addEventListener(ev, armIdleWatch);
  });
  armIdleWatch();

  // 初始化 Live2D（ENABLED=false 时直接 no-op）；启用后若 SDK/模型失败，其内部自动回退 PNG
  if (L2D) L2D.init();
})();
