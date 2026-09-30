/* MOON 对话：CONTROL 输入 → 衡几 Worker /fox/chat（mode:'moon'）。
   - 每次请求带上经验库（remember times）与技能清单，MOON 据经验参谋；
   - 工具浏览器端执行：天气（open-meteo）、提醒（Notification）、
     divine（铜钱起卦＋查 assets/brain/zhouyi.json 经辞原文）；
   - 语音交互：Web Speech Recognition 中文识别，fox-head 头像随听/说波动。 */
(function () {
  'use strict';

  var API_URL = 'https://hengji.sevencolor.space/fox/chat';

  var textarea = document.getElementById('text-input');
  var sendBtn = document.getElementById('send-btn');
  var voiceBtn = document.getElementById('voice-btn');
  var micBtn = document.getElementById('mic-btn');
  var transcript = document.querySelector('.transcript');
  var body = document.getElementById('transcript-body');
  var centerStatus = document.getElementById('center-status');
  var statMic = document.getElementById('stat-mic');
  var avatar = document.getElementById('voice-avatar');

  var history = [];   // 完整对话历史（含 tool_use / tool_result）
  var busy = false;
  var voiceOn = true; // 女声：开（与按钮初始文案一致）
  var savedVoice = true; // 禁声前的女声偏好，解禁时恢复
  var voiceMode = false; // 本轮对话由语音交互发起（头像随流程显示）

  function renderVoiceBtn() {
    voiceBtn.textContent = '女声：' + (voiceOn ? '开' : '关');
    voiceBtn.classList.toggle('is-active', voiceOn);
  }
  renderVoiceBtn();

  /* ---------------- 经验库：启动即取，随每轮请求发给 MOON ---------------- */
  function loadStore() {
    return fetch('assets/brain/memories.json', { cache: 'no-cache' })
      .then(function (r) { return r.json(); })
      .catch(function () { return { skills: [], memories: [] }; });
  }
  var storePromise = loadStore();

  /* 禁声总闸（brain-boot.js 的 window.MOON） */
  if (window.MOON && window.MOON.onMute) {
    window.MOON.onMute(function (muted) {
      if (muted) {
        voiceOn = false;
        if ('speechSynthesis' in window) speechSynthesis.cancel();
      } else {
        voiceOn = savedVoice;
      }
      renderVoiceBtn();
    });
  }

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
    if (!voiceOn || !text || !('speechSynthesis' in window)) {
      if (voiceMode) setAvatar('hidden');   // 无语音可播：直接收头像
      return;
    }
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.pitch = 0.8;
    u.rate = 0.95;
    var v = pickZhVoice();
    if (v) u.voice = v;
    u.onend = u.onerror = function () {
      if (voiceMode && !busy) setAvatar('hidden');
    };
    speechSynthesis.speak(u);
  }

  voiceBtn.addEventListener('click', function () {
    if (window.MOON && window.MOON.muted) { window.MOON.setMuted(false); return; }
    voiceOn = !voiceOn;
    savedVoice = voiceOn;
    renderVoiceBtn();
    if (!voiceOn && 'speechSynthesis' in window) speechSynthesis.cancel();
  });
  if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = function () {};

  /* ---------------- 工具：起卦（divine） ---------------- */
  var TRI = ['乾', '兑', '离', '震', '巽', '坎', '艮', '坤'];
  // 行＝上卦，列＝下卦
  var GUA_TABLE = {
    乾: ['乾为天', '天泽履', '天火同人', '天雷无妄', '天风姤', '天水讼', '天山遁', '天地否'],
    兑: ['泽天夬', '兑为泽', '泽火革', '泽雷随', '泽风大过', '泽水困', '泽山咸', '泽地萃'],
    离: ['火天大有', '火泽睽', '离为火', '火雷噬嗑', '火风鼎', '火水未济', '火山旅', '火地晋'],
    震: ['雷天大壮', '雷泽归妹', '雷火丰', '震为雷', '雷风恒', '雷水解', '雷山小过', '雷地豫'],
    巽: ['风天小畜', '风泽中孚', '风火家人', '风雷益', '巽为风', '风水涣', '风山渐', '风地观'],
    坎: ['水天需', '水泽节', '水火既济', '水雷屯', '水风井', '坎为水', '水山蹇', '水地比'],
    艮: ['山天大畜', '山泽损', '山火贲', '山雷颐', '山风蛊', '山水蒙', '艮为山', '山地剥'],
    坤: ['地天泰', '地泽临', '地火明夷', '地雷复', '地风升', '地水师', '地山谦', '坤为地']
  };
  var TRI_CODE = [[1, 1, 1], [1, 1, 0], [1, 0, 1], [1, 0, 0],
                  [0, 1, 1], [0, 1, 0], [0, 0, 1], [0, 0, 0]];
  var YAO_NAMES = ['初', '二', '三', '四', '五', '上'];

  function triIndex(code) {
    var b = code.map(Number);
    for (var i = 0; i < TRI_CODE.length; i++) {
      if (TRI_CODE[i][0] === b[0] && TRI_CODE[i][1] === b[1] && TRI_CODE[i][2] === b[2]) return i;
    }
    return -1;
  }
  function guaName(yang) {
    return GUA_TABLE[TRI[triIndex(yang.slice(3, 6))]][triIndex(yang.slice(0, 3))];
  }
  function yaoKey(yangAtLine, posIdx) {
    // 初/上：位在前（初九、上六）；其余：阴阳在前（九二、六五）
    var nine = yangAtLine ? '九' : '六';
    return (posIdx === 0 || posIdx === 5)
      ? YAO_NAMES[posIdx] + nine
      : nine + YAO_NAMES[posIdx];
  }
  function reading(zhouyi, name, key, label) {
    var g = zhouyi[name];
    var text = key === '卦辞' ? g && g.gua_ci : g && g.yao && g.yao[key];
    return text ? { source: name + ' · ' + (label || key), text: text } : null;
  }

  var zhouyiPromise = null;
  function loadZhouyi() {
    if (!zhouyiPromise) {
      zhouyiPromise = fetch('assets/brain/zhouyi.json', { cache: 'force-cache' })
        .then(function (r) { return r.json(); });
    }
    return zhouyiPromise;
  }

  function divine() {
    var r = new Uint8Array(6);
    crypto.getRandomValues(r);
    // 每爻：0..255 映射 6/7/8/9（老阴/少阳/少阴/老阳）
    var lines = [].map.call(r, function (x) { return [6, 7, 8, 9][x % 4]; });
    var yangNow = lines.map(function (v) { return v === 7 || v === 9 ? 1 : 0; });
    var yangBian = lines.map(function (v) { return v === 6 || v === 7 ? 1 : 0; });
    var moving = lines.map(function (v, i) { return (v === 6 || v === 9) ? i : -1; })
      .filter(function (i) { return i >= 0; });
    var name = guaName(yangNow);
    var bian = moving.length ? guaName(yangBian) : null;

    return loadZhouyi().then(function (zy) {
      var rs = [];
      var primary = 0;
      var n = moving.length;
      if (n === 0) {
        rs.push(reading(zy, name, '卦辞'));
      } else if (n === 1) {
        var i = moving[0];
        rs.push(reading(zy, name, yaoKey(yangNow[i], i)));
      } else if (n === 2) {
        moving.forEach(function (i) { rs.push(reading(zy, name, yaoKey(yangNow[i], i))); });
        primary = 1; // 以上爻为主
      } else if (n === 3) {
        rs.push(reading(zy, name, '卦辞', '本卦卦辞'));
        rs.push(reading(zy, bian, '卦辞', '变卦卦辞'));
        primary = 1;
      } else if (n === 4) {
        // 变卦两静爻，以下爻为主
        var still = [];
        for (var k = 0; k < 6; k++) { if (moving.indexOf(k) < 0) still.push(k); }
        rs.push(reading(zy, bian, yaoKey(yangBian[still[0]], still[0]), '变卦' + yaoKey(yangBian[still[0]], still[0])));
        rs.push(reading(zy, bian, yaoKey(yangBian[still[1]], still[1]), '变卦' + yaoKey(yangBian[still[1]], still[1])));
      } else if (n === 5) {
        var s = -1;
        for (var j = 0; j < 6; j++) { if (moving.indexOf(j) < 0) s = j; }
        rs.push(reading(zy, bian, yaoKey(yangBian[s], s), '变卦' + yaoKey(yangBian[s], s)));
      } else {
        // 六爻全动：变卦卦辞；乾→坤用九、坤→乾用六
        if (name === '乾为天') rs.push(reading(zy, '乾为天', '用九'));
        else if (name === '坤为地') rs.push(reading(zy, '坤为地', '用六'));
        else rs.push(reading(zy, bian, '卦辞', '变卦卦辞'));
      }
      return {
        hexagram: name,
        bian: bian,
        moving_lines: moving.map(function (i) { return i + 1; }),
        line_values: lines,
        readings: rs.filter(Boolean),
        primary_reading_index: primary
      };
    });
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
    if (name === 'divine') return divine();
    return Promise.resolve({ ok: false, error: '未知工具：' + name });
  }

  function toolHint(name) {
    if (name === 'get_weather') return 'MOON 看了看天色…';
    if (name === 'divine') return 'MOON 凝神起了一卦…';
    return 'MOON 记下了…';
  }

  /* ---------------- 语音头像：听/说两态 ---------------- */
  function setAvatar(state) {
    avatar.classList.toggle('is-listening', state === 'listening');
    avatar.classList.toggle('is-speaking', state === 'speaking');
    if (state === 'hidden') {
      voiceMode = false;
      renderMicBtn(false);
      statMic.textContent = 'PENDING';
    }
  }

  function renderMicBtn(listening) {
    micBtn.classList.toggle('is-active', listening);
    micBtn.querySelector('.ctrl-dot').style.display = listening ? 'none' : '';
    micBtn.lastChild.textContent = listening ? ' 正在聆听…（点按停止）' : ' 语音交互';
  }

  /* ---------------- 语音识别 ---------------- */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var recognition = null;
  var micOn = false;
  var gotFinal = false;

  if (!SR) {
    micBtn.disabled = true;
    micBtn.lastChild.textContent = ' 语音不可用';
  } else {
    micBtn.addEventListener('click', toggleMic);
  }

  function toggleMic() {
    if (micOn) { recognition.stop(); return; }
    recognition = new SR();
    recognition.lang = 'zh-CN';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    gotFinal = false;

    recognition.onstart = function () {
      micOn = true;
      voiceMode = true;
      renderMicBtn(true);
      statMic.textContent = 'LISTENING';
      setAvatar('listening');
      textarea.value = '';
    };
    recognition.onresult = function (e) {
      var transcriptText = '';
      var finalText = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else transcriptText += e.results[i][0].transcript;
      }
      if (finalText) {
        gotFinal = true;
        textarea.value = finalText.trim();
        recognition.stop();
      } else {
        textarea.value = transcriptText;
      }
    };
    recognition.onerror = function (e) {
      micOn = false;
      if (!gotFinal) {
        setAvatar('hidden');
        pushLine('MOON', 'interim', '语音没有听清（' + e.error + '），可重试或改用文字。');
      }
    };
    recognition.onend = function () {
      micOn = false;
      if (gotFinal && textarea.value.trim()) {
        send();   // 识别完成：自动发送，头像转「正在回复」
      } else if (!voiceMode) {
        setAvatar('hidden');
      }
    };
    try { recognition.start(); }
    catch (err) { setAvatar('hidden'); }
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
    if (voiceMode) {
      statMic.textContent = 'RESPONDING';
      setAvatar('speaking');
    }

    function finish() {
      busy = false;
      sendBtn.disabled = false;
      if (centerStatus.textContent === 'PROCESSING…') {
        centerStatus.textContent = 'ONLINE AND ACTIVE';
      }
      textarea.focus();
      // 无 TTS（禁声等）时 API 结束即收头像
      if (voiceMode && (!('speechSynthesis' in window) || !voiceOn)) setAvatar('hidden');
    }

    function step(store) {
      return fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'moon',
          messages: history,
          experiences: store.memories || [],
          skills: store.skills || []
        })
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
            return storePromise.then(step);
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

    storePromise.then(step).then(finish, function (err) {
      waiting.querySelector('.t-text').textContent = '连接出了问题：' + (err.message || err);
      if (voiceMode) setAvatar('hidden');
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
})();
