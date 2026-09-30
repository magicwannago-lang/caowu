/* MOON 对话：CONTROL 输入 → 衡几 Worker /fox/chat，
   对话流实时显示在左栏 TRANSCRIPT；工具（天气/提醒）浏览器端执行；
   女声开关控制回复语音。与主站小狐同一后端协议，这里是 MOON 自己的界面。 */
(function () {
  'use strict';

  var API_URL = 'https://hengji.sevencolor.space/fox/chat';

  var textarea = document.getElementById('text-input');
  var sendBtn = document.getElementById('send-btn');
  var voiceBtn = document.getElementById('voice-btn');
  var transcript = document.querySelector('.transcript');
  var body = document.getElementById('transcript-body');
  var centerStatus = document.getElementById('center-status');
  var statMic = document.getElementById('stat-mic');

  var history = [];   // 完整对话历史（含 tool_use / tool_result）
  var busy = false;
  var voiceOn = true; // 女声：开（与按钮初始文案一致）

  voiceBtn.classList.add('is-active');

  /* ---------------- TRANSCRIPT 行 ---------------- */
  function pushLine(who, cls, text) {
    transcript.classList.add('has-content');
    var line = document.createElement('div');
    line.className = 't-line ' + cls;
    var whoEl = document.createElement('span');
    whoEl.className = 't-who';
    whoEl.textContent = who;
    var textEl = document.createElement('span');
    textEl.className = 't-text';
    textEl.textContent = text;
    line.appendChild(whoEl);
    line.appendChild(textEl);
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
    return line;
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
    if (!voiceOn || !text || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.pitch = 0.8;
    u.rate = 0.95;
    var v = pickZhVoice();
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }

  voiceBtn.addEventListener('click', function () {
    voiceOn = !voiceOn;
    voiceBtn.textContent = '女声：' + (voiceOn ? '开' : '关');
    voiceBtn.classList.toggle('is-active', voiceOn);
    if (!voiceOn && 'speechSynthesis' in window) speechSynthesis.cancel();
  });
  if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = function () {};

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
          + '&longitude=' + loc.longitude + '&current=temperature_2d,weathercode';
        return fetch(url)
          .then(function (r) { return r.json(); })
          .then(function (fc) {
            return {
              ok: true,
              city: loc.name,
              temperature: fc.current.temperature_2d,
              description: WMO_CODES[fc.current.weathercode] || '未知天气'
            };
          });
      });
  }

  /* ---------------- 工具：提醒 ---------------- */
  function setReminder(minutes, message) {
    var ms = Math.max(0, Number(minutes)) * 60000;
    function schedule() {
      setTimeout(function () {
        new Notification('MOON 提醒', { body: message });
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
      remind_at: new Date(Date.now() + ms).toLocaleTimeString('zh-CN')
    });
  }

  function runTool(name, input) {
    if (name === 'get_weather') return getWeather(input.city);
    if (name === 'set_reminder') return setReminder(input.minutes, input.message);
    return Promise.resolve({ ok: false, error: '未知工具：' + name });
  }

  function toolHint(name) {
    return name === 'get_weather' ? 'MOON 看了看天色…' : 'MOON 记下了…';
  }

  /* ---------------- 发送主循环 ---------------- */
  function send() {
    var text = textarea.value.trim();
    if (busy || !text) return;
    textarea.value = '';
    textarea.style.height = 'auto';

    pushLine('USER', 'user', text);
    history.push({ role: 'user', content: text });
    var waiting = pushLine('MOON', 'interim', 'MOON 正在想…');

    busy = true;
    sendBtn.disabled = true;
    centerStatus.textContent = 'PROCESSING…';

    function finish() {
      busy = false;
      sendBtn.disabled = false;
      if (centerStatus.textContent === 'PROCESSING…') {
        centerStatus.textContent = 'ONLINE AND ACTIVE';
      }
      textarea.focus();
    }

    function step() {
      return fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history })
      }).then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error((data.error && data.error.message) || data.error || '请求失败');
          return data;
        });
      }).then(function (data) {
        history.push({ role: 'assistant', content: data.content });

        if (data.stop_reason === 'tool_use') {
          var results = [];
          var jobs = data.content
            .filter(function (b) { return b.type === 'tool_use'; })
            .map(function (block) {
              waiting.querySelector('.t-text').textContent = toolHint(block.name);
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
            history.push({ role: 'user', content: results });
            return step();
          });
        }

        var reply = data.content
          .filter(function (b) { return b.type === 'text'; })
          .map(function (b) { return b.text; })
          .join('')
          .trim();
        body.removeChild(waiting);
        if (reply) {
          pushLine('MOON', 'moon', reply);
          speak(reply);
        }
      });
    }

    step().then(finish, function (err) {
      waiting.querySelector('.t-text').textContent = '连接出了问题：' + (err.message || err);
      finish();
    });
  }

  /* ---------------- 事件 ---------------- */
  sendBtn.addEventListener('click', send);
  textarea.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  // 语音输入尚未启用：mic 保持禁用，LINK 的 speech input 仍 PENDING
  statMic.textContent = 'PENDING';
})();
