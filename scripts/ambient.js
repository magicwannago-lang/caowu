/* ============================================================
   草屋 · 听音（合成层）
   雨声与流水，合成而非素材——零依赖、零体积、可离线。
   没有音频文件时，这层就是全站的声源。

   声音性格：雨丝细密不刺耳，流水低沉不喧哗。
   所有变化以秒计，最快也是 8 秒一轮——不做脉冲，不做节拍。
   ============================================================ */

window.Ambient = (function () {
  'use strict';

  var STORE_KEY = 'caowu.ambient.on';
  var VOL_KEY = 'caowu.ambient.vol';

  var ctx = null;
  var master = null;
  var voice = null;          // { stop }
  var playing = false;
  var volume = readVol();
  var ducked = false;        // 真曲目在响时，合成层让位

  var listeners = { change: [] };

  /* ---------- 小工具 ---------- */

  function readVol() {
    try {
      var v = parseFloat(localStorage.getItem(VOL_KEY));
      return isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.42;
    } catch (e) { return 0.42; }
  }

  function remember(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* 隐私模式，忽略 */ }
  }

  function emit() {
    var state = { playing: playing && !ducked, volume: volume };
    listeners.change.forEach(function (fn) {
      try { fn(state); } catch (e) { /* 监听者出错不影响播放 */ }
    });
  }

  function reduced() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  /* ---------- 合成：白噪声 → 滤波器 ---------- */

  function noiseBuffer(seconds) {
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);

    // 极简一阶粉化：让白噪声沉下去，接近自然的底噪
    var last = 0;
    for (var i = 0; i < len; i++) {
      var white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.2 + white * 0.55;
    }
    return buf;
  }

  function loopSource(buffer) {
    var src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    return src;
  }

  function buildVoice() {
    var out = ctx.createGain();
    out.gain.value = 0;
    out.connect(master);

    var nodes = [];

    /* --- 雨：高通后的细碎噪声，加几缕缓慢游移的「密」 --- */
    var rainGain = ctx.createGain();
    rainGain.gain.value = 0.55;

    var rainHP = ctx.createBiquadFilter();
    rainHP.type = 'highpass';
    rainHP.frequency.value = 900;
    rainHP.Q.value = 0.4;

    var rainLP = ctx.createBiquadFilter();
    rainLP.type = 'lowpass';
    rainLP.frequency.value = 7200;

    var rainSrc = loopSource(noiseBuffer(6));
    rainSrc.connect(rainHP);
    rainHP.connect(rainLP);
    rainLP.connect(rainGain);
    rainGain.connect(out);

    // 雨势的呼吸：8~13 秒一轮，幅度极小（±18%）
    var rainTide = ctx.createOscillator();
    rainTide.type = 'sine';
    rainTide.frequency.value = 1 / 11;
    var rainTideAmt = ctx.createGain();
    rainTideAmt.gain.value = 0.10;
    rainTide.connect(rainTideAmt);
    rainTideAmt.connect(rainGain.gain);

    // 高低切也随呼吸轻移，避免听出「循环」
    var tide2 = ctx.createOscillator();
    tide2.type = 'sine';
    tide2.frequency.value = 1 / 17;
    var tide2Amt = ctx.createGain();
    tide2Amt.gain.value = 320;
    tide2.connect(tide2Amt);
    tide2Amt.connect(rainLP.frequency);

    nodes.push(rainSrc, rainTide, tide2);

    /* --- 流水：低通后的噪声 + 两条失谐正弦，微微起伏 --- */
    var flowGain = ctx.createGain();
    flowGain.gain.value = 0.30;

    var flowLP = ctx.createBiquadFilter();
    flowLP.type = 'lowpass';
    flowLP.frequency.value = 620;

    var flowSrc = loopSource(noiseBuffer(8));
    flowSrc.connect(flowLP);
    flowLP.connect(flowGain);
    flowGain.connect(out);

    // 水流的来回：慢到近乎不觉
    var flowSway = ctx.createOscillator();
    flowSway.type = 'sine';
    flowSway.frequency.value = 1 / 13;
    var flowSwayAmt = ctx.createGain();
    flowSwayAmt.gain.value = 160;
    flowSway.connect(flowSwayAmt);
    flowSwayAmt.connect(flowLP.frequency);

    // 低频的两个音，水底的沉响
    var droneGain = ctx.createGain();
    droneGain.gain.value = 0.035;
    droneGain.connect(out);

    [
      { f: 138.6, d: 0 },      // 近于 C#3
      { f: 207.7, d: 0.6 }     // 微失谐，形成极缓的拍频
    ].forEach(function (tone) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = tone.f;
      var g = ctx.createGain();
      g.gain.value = 1;
      osc.connect(g);
      g.connect(droneGain);

      // 每个音自己的极缓音量起伏
      var lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = 1 / (14 + tone.d * 7);
      var lfoAmt = ctx.createGain();
      lfoAmt.gain.value = 0.5;
      lfo.connect(lfoAmt);
      lfoAmt.connect(g.gain);

      nodes.push(osc, lfo);
      osc.start();
      lfo.start();
    });

    nodes.push(flowSrc, flowSway);
    flowSrc.start();
    flowSway.start();
    rainSrc.start();
    rainTide.start();
    tide2.start();

    return {
      out: out,
      stop: function () {
        nodes.forEach(function (n) {
          try { if (n.stop) n.stop(); } catch (e) { /* 已停 */ }
        });
        try { out.disconnect(); } catch (e) { /* 已断 */ }
      }
    };
  }

  /* ---------- 主控 ---------- */

  function ensure() {
    if (ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
  }

  function ramp(target, seconds) {
    if (!master) return;
    var now = ctx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(target, now + seconds);
  }

  function level() {
    return Math.pow(volume, 1.15);
  }

  function setVolume(v, immediate) {
    volume = Math.min(1, Math.max(0, v));
    remember(VOL_KEY, volume);
    if (playing && !ducked) ramp(level(), immediate ? 0.05 : 0.6);
    emit();
  }

  function play() {
    if (playing) return Promise.resolve();

    ensure();
    if (ctx.state === 'suspended') ctx.resume();

    if (!voice) voice = buildVoice();
    playing = true;
    remember(STORE_KEY, '1');
    if (!ducked) ramp(level(), 1.8);   // 缓缓起来，不突兀
    emit();
    return Promise.resolve();
  }

  function pause() {
    if (!playing) return;
    playing = false;
    remember(STORE_KEY, '0');
    ramp(0, 0.9);   // 缓缓退去
    emit();
  }

  function toggle() {
    return playing ? (pause(), Promise.resolve()) : play();
  }

  /* ---------- 让位：真曲目起声时，合成层退到后面 ---------- */

  function duck() {
    if (ducked) return;
    ducked = true;
    if (master && ctx) ramp(0, 0.5);
    emit();
  }

  function unduck() {
    if (!ducked) return;
    ducked = false;
    if (playing && master && ctx) ramp(level(), 0.8);
    emit();
  }

  /* ---------- 对外 ---------- */

  var api = {
    init: function () {
      if (playing) return;
      var wants = false;
      try { wants = localStorage.getItem(STORE_KEY) === '1'; } catch (e) { /* 忽略 */ }

      if (!wants) { emit(); return; }

      // 上次开着：等第一次用户手势再起声（浏览器政策所限，也合礼数）
      var kick = function () {
        document.removeEventListener('pointerdown', kick);
        document.removeEventListener('keydown', kick);
        play();
      };
      document.addEventListener('pointerdown', kick, { once: true });
      document.addEventListener('keydown', kick, { once: true });
      emit();
    },
    toggle: toggle,
    play: play,
    pause: pause,
    duck: duck,
    unduck: unduck,
    setVolume: setVolume,
    getVolume: function () { return volume; },
    isPlaying: function () { return playing && !ducked; },
    isOn: function () { return playing; },
    onChange: function (fn) { listeners.change.push(fn); fn({ playing: playing && !ducked, volume: volume }); },
    reduced: reduced
  };

  return api;
})();
