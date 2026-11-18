/* 坐忘 MVP · 前端核心
 * 状态：intro → breath(黑屏呼吸) → hold(山谷沉浸，吸呼与核心词循环)
 * 模式：默认自动（核心词自动淡出消散）；点右上角开关切手动（长按散去）
 * 声音：Web Audio 实时合成风声 + 颂钵，无音频文件
 * 埋点：crypto.randomUUID() 存 localStorage，全程匿名
 */
(function () {
  'use strict';

  // ---------- 匿名身份 ----------
  function getAnonId() {
    var KEY = 'zw_anon_id';
    var id = null;
    try { id = localStorage.getItem(KEY); } catch (e) {}
    if (!id) {
      id = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
          });
      try { localStorage.setItem(KEY, id); } catch (e) {}
    }
    return id;
  }
  var ANON_ID = getAnonId();

  // ---------- 来源归因 ----------
  function getSource() {
    var q = new URLSearchParams(location.search).get('src');
    return q ? q.slice(0, 32) : 'direct';
  }
  var SRC = getSource();
  var sessionStart = Date.now();
  var fogReported = false;
  var exitReported = false;

  function track(event, extra) {
    var body = { id: ANON_ID, ts: Date.now(), event: event, src: SRC };
    if (extra) { for (var k in extra) body[k] = extra[k]; }
    try {
      fetch('/api/pv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }

  track('page_view');
  window.addEventListener('pagehide', function () { reportExit(); });
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') reportExit();
  });
  function reportExit() {
    if (exitReported) return;
    exitReported = true;
    track('exit', { duration: Date.now() - sessionStart });
  }

  // ---------- DOM ----------
  var canvas = document.getElementById('scene');
  var ctx = canvas.getContext('2d');
  var stageBreath = document.getElementById('stage-breath');
  var stageHold = document.getElementById('stage-hold');
  var valley = document.querySelector('.valley');
  var ring = document.getElementById('breath-ring');
  var textMain = document.getElementById('text-main');
  var pressHint = document.getElementById('press-hint');
  var soundBtn = document.getElementById('sound-toggle');
  var volumeWrap = document.getElementById('volume-wrap');
  var volumeRange = document.getElementById('volume-range');
  var modeBtn = document.getElementById('mode-toggle');

  // 呼吸节奏：吸 4 秒 / 呼 6 秒（每分钟 6 次共振呼吸）
  var INHALE_MS = 4000;
  var EXHALE_MS = 6000;
  var FADE = 1100;          // 与 CSS 文字过渡对齐
  var WORD_HOLD = 5000;     // 自动模式下核心词停留时长（读完再散）
  var DISSOLVE_MS = 2500;   // 消散时长：文字缓慢渐隐 + 微尘持续下落的窗口
  var WORD_GAP = 12000;     // 两次核心词之间的呼吸间隔
  var PRESS_MS = 900;       // 手动模式长按散去的阈值
  var breathPhase = '吸';   // 下一个要显示的阶段

  var WORDS = ['松开', '让它流过', '不必抓住', '在此刻', '呼吸'];
  var wordIndex = -1;
  var autoMode = true;      // true=自动消散；false=手动长按散去

  var breathTimer = null;
  var wordTimer = null;
  var holdTimer = null;
  var seepTimer = null;     // 微尘分批渗出的定时器
  var wordActive = false;   // 核心词当前是否占据圆环中心
  var dissipating = false;
  var pressing = false;
  var pressRAF = null;
  var pressStart = 0;

  var state = 'intro';      // intro | breath | hold
  var started = false;

  // ---------- Canvas 粒子 ----------
  var particles = [];
  var W = 0, H = 0, DPR = 1;
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  function spawnMotes(n) {
    particles = [];
    for (var i = 0; i < n; i++) {
      particles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 1.6 + 0.4,
        vx: (Math.random() - 0.5) * 0.12,
        vy: -Math.random() * 0.18 - 0.04,
        baseA: Math.random() * 0.35 + 0.05,
        a: 0,
        tw: Math.random() * Math.PI * 2,
        burst: false
      });
    }
  }

  function drawParticles(t) {
    ctx.clearRect(0, 0, W, H);
    var fadeBand = 90;
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      if (p.burst) {
        // 消散微尘：从文字位置缓缓向下飘散，左右轻摆，慢慢淡去
        p.y += p.vy;
        p.x += p.vx + Math.sin(t * 0.0012 + p.tw) * 0.12;
        p.baseA *= 0.996;
        p.a = p.y > H + 6 ? 0 : p.baseA; // 触底即隐，交给下方统一回收
      } else {
        // 默认：浮尘缓慢下落 + 轻微左右摇曳；触底渐隐
        p.y += Math.abs(p.vy) * 0.55 + 0.06;
        p.x += Math.sin(t * 0.0009 + p.tw) * 0.1;
        var fade = 1;
        if (p.y > H - fadeBand) fade = Math.max(0, (H - p.y) / fadeBand);
        p.a = p.baseA * fade;
        if (p.y > H + 4) { p.y = -4; p.x = Math.random() * W; }
      }
      var alpha = p.a * (0.6 + 0.4 * Math.sin(t * 0.001 + p.tw));
      if (alpha <= 0.004) {
        if (p.burst) { particles.splice(i, 1); i--; }
        continue;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(216, 206, 192, ' + alpha.toFixed(3) + ')';
      ctx.fill();
    }
  }

  function loop(t) {
    drawParticles(t);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // 文字化微尘：记住文字位置，随后分批持续渗出（不再瞬间引爆）
  var dissolveOrigin = null;
  function dissolveWord() {
    var rect = textMain.getBoundingClientRect();
    dissolveOrigin = {
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      w: rect.width,
      h: rect.height
    };
    clearInterval(seepTimer);
    // 整个消散窗口内均匀渗出，与文字 2.5s 渐隐同步
    var batch = 0;
    var totalBatches = Math.max(1, Math.floor(DISSOLVE_MS / 110));
    seepTimer = setInterval(function () {
      if (!dissolveOrigin || batch++ >= totalBatches) {
        clearInterval(seepTimer); seepTimer = null; return;
      }
      seepMotes(7);
    }, 110);
    seepMotes(7); // 先渗出第一批
  }

  // 从文字位置渗出少量微尘：初速极小、缓缓向下、轻柔淡出
  function seepMotes(n) {
    if (!dissolveOrigin) return;
    var o = dissolveOrigin;
    for (var i = 0; i < n; i++) {
      particles.push({
        x: o.cx + (Math.random() - 0.5) * o.w * 0.9,
        y: o.cy + (Math.random() - 0.5) * o.h * 0.7,
        r: Math.random() * 1.4 + 0.5,
        vx: (Math.random() - 0.5) * 0.16,
        vy: Math.random() * 0.35 + 0.12,
        baseA: 0.75,
        a: 0.75,
        tw: Math.random() * Math.PI * 2,
        burst: true
      });
    }
  }

  // ---------- Web Audio 合成：风声 + 颂钵 ----------
  var audioCtx = null;
  var masterGain = null;
  var audioReady = false;
  var MAX_GAIN = 0.7;        // 滑杆拉满时的主增益
  var VOL_KEY = 'zw_volume';
  function loadVolume() {
    try {
      var v = parseFloat(localStorage.getItem(VOL_KEY));
      if (!isNaN(v) && v >= 0 && v <= 1) return v;
    } catch (e) {}
    return 0.72;             // 默认约等于原先的 0.5 增益
  }
  var volume = loadVolume(); // 0..1，滑到底为 0（静音）
  var bowlTimer = null;

  function initAudio() {
    if (audioReady) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(audioCtx.destination);

    var dur = 4;
    var buf = audioCtx.createBuffer(1, audioCtx.sampleRate * dur, audioCtx.sampleRate);
    var data = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < data.length; i++) {
      var white = Math.random() * 2 - 1;
      last = last * 0.98 + white * 0.02;
      data[i] = last * 3.2;
    }
    var noise = audioCtx.createBufferSource();
    noise.buffer = buf; noise.loop = true;
    var lp = audioCtx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 520; lp.Q.value = 0.4;
    var windGain = audioCtx.createGain();
    windGain.gain.value = 0.5;
    noise.connect(lp); lp.connect(windGain); windGain.connect(masterGain);
    noise.start();

    var lfo = audioCtx.createOscillator();
    var lfoGain = audioCtx.createGain();
    lfo.frequency.value = 0.08; lfoGain.gain.value = 0.28;
    lfo.connect(lfoGain); lfoGain.connect(windGain.gain);
    lfo.start();

    audioReady = true;
    scheduleBowl();
  }

  function playBowl() {
    if (!audioReady || volume <= 0 || !audioCtx) return;
    var now = audioCtx.currentTime;
    var base = 180 + Math.random() * 60;
    var partials = [1, 2.01, 3.03, 4.2];
    var gains = [0.16, 0.07, 0.04, 0.02];
    var bus = audioCtx.createGain();
    bus.gain.value = 1;
    bus.connect(masterGain);
    partials.forEach(function (mul, idx) {
      var osc = audioCtx.createOscillator();
      var g = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = base * mul;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(gains[idx], now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 6 + idx);
      osc.connect(g); g.connect(bus);
      osc.start(now); osc.stop(now + 7 + idx);
    });
  }

  function scheduleBowl() {
    if (bowlTimer) clearTimeout(bowlTimer);
    bowlTimer = setTimeout(function () {
      playBowl();
      scheduleBowl();
    }, 11000 + Math.random() * 7000);
  }

  function fadeInAudio() {
    initAudio();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') audioCtx.resume();
    masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
    masterGain.gain.setValueAtTime(masterGain.gain.value, audioCtx.currentTime);
    masterGain.gain.linearRampToValueAtTime(volume * MAX_GAIN, audioCtx.currentTime + 2.5);
  }

  // ---------- 右上角开关与音量 ----------
  function applyVolume(animate) {
    if (!masterGain || !audioCtx) return;
    var target = volume * MAX_GAIN;
    var now = audioCtx.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(masterGain.gain.value, now);
    masterGain.gain.linearRampToValueAtTime(target, now + (animate ? 0.12 : 0.01));
    soundBtn.classList.toggle('muted', volume <= 0);
  }

  function syncVolumeUI() {
    volumeRange.value = String(Math.round(volume * 100));
    soundBtn.classList.toggle('muted', volume <= 0);
  }
  syncVolumeUI();

  // 点声音图标：展开/收起竖向音量滑杆（不再直接静音）
  soundBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var showing = volumeWrap.classList.toggle('show');
    volumeWrap.setAttribute('aria-hidden', showing ? 'false' : 'true');
    soundBtn.setAttribute('aria-expanded', showing ? 'true' : 'false');
    if (showing) initAudio(); // 首次展开即就绪，拖动立刻出声
  });

  // 拖动滑杆：实时调音量，滑到底静音；记住选择
  volumeRange.addEventListener('input', function (e) {
    e.stopPropagation();
    volume = Math.max(0, Math.min(1, Number(volumeRange.value) / 100));
    try { localStorage.setItem(VOL_KEY, String(volume)); } catch (err) {}
    soundBtn.classList.toggle('muted', volume <= 0);
    applyVolume(true);
  });
  volumeRange.addEventListener('pointerdown', function (e) { e.stopPropagation(); });

  modeBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    autoMode = !autoMode;
    modeBtn.classList.toggle('manual', !autoMode);
    modeBtn.setAttribute('aria-label', autoMode ? '当前自动模式' : '当前手动模式');
    syncHint(); // 手动模式且核心词正出现时才显示“长按”
    if (autoMode) {
      // 切回自动：正在停留的核心词开始倒计时消散
      if (wordActive && !dissipating) holdTimer = setTimeout(dissipate, WORD_HOLD);
    } else {
      clearTimeout(holdTimer); // 改为等待用户长按
    }
    track(autoMode ? 'mode_auto' : 'mode_manual');
  });

  // ---------- 圆环中心文字控制 ----------
  function setText(txt, kind) {
    textMain.className = 'text-main is-' + kind + (kind === 'word' ? ' sinking' : '');
    textMain.textContent = txt;
  }
  function showText() { textMain.classList.add('show'); }
  function hideText() { textMain.classList.remove('show'); }

  // “长按”提示：仅在手动模式 + 核心词正显示 + 未消散时，出现在核心词下方
  function syncHint() {
    var show = !autoMode && wordActive && !dissipating;
    pressHint.classList.toggle('show', show);
  }

  // 吸 4 秒扩张 / 呼 6 秒收缩，环内文字同步切换，无限循环
  function breathStep() {
    if (!started || wordActive) return;
    var label = breathPhase;
    var inhaling = label === '吸';
    breathPhase = inhaling ? '呼' : '吸';
    ring.classList.toggle('inhale', inhaling);
    ring.classList.toggle('exhale', !inhaling);
    setText(label, 'breath');
    showText();
    breathTimer = setTimeout(breathStep, inhaling ? INHALE_MS : EXHALE_MS);
  }
  function pauseBreath() { clearTimeout(breathTimer); breathTimer = null; }
  function resumeBreath() { if (!breathTimer && started && !wordActive) breathStep(); }
  function scheduleWord(delay) { clearTimeout(wordTimer); wordTimer = setTimeout(showWord, delay); }

  // 核心词进入圆环中心：淡入 → 停留（自动模式倒计时 / 手动模式等长按）
  function showWord() {
    if (!started || wordActive) return;
    wordActive = true;
    pauseBreath();
    hideText();
    setTimeout(function () {
      if (!started) return;
      wordIndex = (wordIndex + 1) % WORDS.length;
      setText(WORDS[wordIndex], 'word');
      showText();
      syncHint(); // 核心词出现时，手动模式下显示“长按”
      if (autoMode) holdTimer = setTimeout(dissipate, WORD_HOLD);
    }, FADE);
  }

  // 散去：文字化微尘、淡出，再回到呼吸循环
  function dissipate() {
    if (!wordActive || dissipating) return;
    dissipating = true;
    syncHint(); // 开始消散即隐藏“长按”，避免提示悬在渐隐文字下
    clearTimeout(holdTimer);
    cancelPress();
    dissolveWord();
    track('dissipate_done');
    textMain.classList.add('dissolving');
    setTimeout(function () {
      clearInterval(seepTimer); seepTimer = null; dissolveOrigin = null;
      textMain.classList.remove('dissolving');
      hideText();
      setTimeout(function () {
        wordActive = false;
        dissipating = false;
        syncHint();
        resumeBreath();
        scheduleWord(WORD_GAP);
      }, FADE);
    }, DISSOLVE_MS); // 2.5s 缓慢渐隐，微尘同步持续下落
  }

  // 手动模式：长按圆环中心文字使其散去（无进度环，只做柔和模糊淡出）
  function tickPress() {
    if (!pressing) return;
    var r = Math.min((performance.now() - pressStart) / PRESS_MS, 1);
    textMain.style.opacity = String(1 - r * 0.9);
    textMain.style.filter = 'blur(' + (r * 6).toFixed(1) + 'px)';
    if (r >= 1) {
      pressing = false;
      resetPressStyle();
      dissipate();
      return;
    }
    pressRAF = requestAnimationFrame(tickPress);
  }
  function resetPressStyle() {
    textMain.style.opacity = '';
    textMain.style.filter = '';
    textMain.style.transition = '';
  }
  function cancelPress() {
    if (pressRAF) cancelAnimationFrame(pressRAF);
    pressRAF = null;
    if (pressing) { pressing = false; resetPressStyle(); }
  }

  // ---------- 流程状态机 ----------
  function switchStage(from, to) {
    if (from) from.classList.remove('active');
    if (to) to.classList.add('active');
  }

  function begin() {
    if (started) return;
    started = true;
    spawnMotes(1000);
    fadeInAudio();
    state = 'breath';
    switchStage(null, stageBreath);
    hideText(); // “轻触开始”淡出
    setTimeout(function () {
      breathPhase = '吸';
      breathStep();
    }, FADE);

    // 一轮完整呼吸（10s）后雾散，山谷浮现；呼吸与核心词继续自动循环
    setTimeout(function () {
      state = 'hold';
      switchStage(stageBreath, stageHold);
      valley.classList.add('show');
      if (!fogReported) { fogReported = true; track('fog_revealed'); }
      scheduleWord(6000); // 山谷浮现 6s 后出现第一个核心词
    }, 10000);
  }

  // ---------- 交互绑定 ----------
  function closeVolumePanel() {
    if (!volumeWrap.classList.contains('show')) return;
    volumeWrap.classList.remove('show');
    volumeWrap.setAttribute('aria-hidden', 'true');
    soundBtn.setAttribute('aria-expanded', 'false');
  }

  function onPressDown(e) {
    if (e.target && e.target.closest && e.target.closest('#volume-wrap, #sound-toggle')) return;
    if (e.target && e.target.closest && e.target.closest('#mode-toggle')) {
      closeVolumePanel();
      return;
    }
    closeVolumePanel();
    if (!started) { begin(); return; }
    if (!autoMode && wordActive && !dissipating) {
      pressing = true;
      pressStart = performance.now();
      textMain.style.transition = 'none';
      tickPress();
    }
  }
  function onPressUp() { cancelPress(); }

  window.addEventListener('pointerdown', onPressDown);
  window.addEventListener('pointerup', onPressUp);
  window.addEventListener('pointercancel', onPressUp);
  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      if (!started) begin();
    }
  });

  // 首屏显示“轻触开始”（位于圆环中心）
  setText('轻触开始', 'hint');
  requestAnimationFrame(function () { requestAnimationFrame(showText); });
})();
