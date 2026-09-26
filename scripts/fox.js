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

  var state = 'idle';          // idle | wave | sleep
  var waveTimer = null;
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

  /* ---------------- 状态切换 ---------------- */
  function setState(next) {
    state = next;
    Object.keys(imgs).forEach(function (name) {
      imgs[name].classList.toggle('active', name === next);
    });
    fox.classList.toggle('sleep', next === 'sleep');
    fox.classList.toggle('float', next === 'idle');
    fox.classList.toggle('wave', next === 'wave');
  }

  function triggerWave() {
    if (state === 'sleep') return;
    clearTimeout(waveTimer);
    setState('wave');
    waveTimer = setTimeout(function () {
      if (state === 'wave') setState('idle');
    }, 1500);
  }

  function toggleSleep() {
    clearTimeout(waveTimer);
    setState(state === 'sleep' ? 'idle' : 'sleep');
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
    speechSynthesis.speak(u);
  }

  soundBtn.addEventListener('click', function () {
    muted = !muted;
    soundBtn.classList.toggle('muted', muted);
    if (muted && 'speechSynthesis' in window) speechSynthesis.cancel();
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
        speak(message);
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

  /* ---------------- 对话主循环 ---------------- */
  function sendMessage(text) {
    if (busy || !text.trim()) return;
    busy = true;
    addBubble('user', text);
    messages.push({ role: 'user', content: text });
    var loading = addBubble('sys', '小狐在想…');

    function finish(err) {
      messagesEl.removeChild(loading);
      busy = false;
      if (err) addBubble('error', err);
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
        if (reply) {
          addBubble('assistant', reply);
          speak(reply);
        }
      });
    }

    step().then(function () { finish(); }, function (err) { finish(err.message); });
  }

  function toolHint(name) {
    return name === 'get_weather' ? '小狐看了看天色…' : '小狐记下了…';
  }

  /* ---------------- 事件绑定 ---------------- */
  fox.addEventListener('click', function () {
    triggerWave();
    togglePanel();
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

  // 加载后 1.5s 自动招手打招呼
  setTimeout(triggerWave, 1500);
})();
