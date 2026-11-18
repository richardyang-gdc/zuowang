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
  var fsBtn = document.getElementById('fs-toggle');

  // 呼吸节奏：吸 4 秒 / 呼 6 秒（每分钟 6 次共振呼吸）
  // 节拍由绝对时钟驱动：环永远按这个周期走，任何文字出现都不改变它。
  var INHALE_MS = 4000;
  var EXHALE_MS = 6000;
  var CYCLE_MS = INHALE_MS + EXHALE_MS;          // 10 秒一轮
  var FADE = 1100;          // 与 CSS 文字过渡对齐
  var DISSOLVE_MS = 2500;   // 消散时长：文字缓慢渐隐 + 微尘持续下落的窗口
  var WORD_AT = INHALE_MS;                        // 核心词在吸气顶点登场（环张到最大那一刻）
  var WORD_PREPARE_AT = WORD_AT - FADE;           // 吸气末先让“吸”淡出，吸满时环心正好空出来
  var WORD_DISSOLVE_AT = CYCLE_MS - DISSOLVE_MS;  // 呼气末段起化尘，正好与环触底同时散尽
  var MANUAL_MAX_MS = CYCLE_MS * 3;               // 手动模式最多停留 3 轮呼吸，之后自己化尘
  var PRESS_MS = 900;       // 手动模式长按散去的阈值

  var WORDS = ['松开', '让它流过', '不必抓住', '在此刻', '呼吸'];
  var wordIndex = -1;
  var autoMode = true;      // true=自动消散；false=手动长按散去

  var beatStart = 0;        // 呼吸时钟原点（performance.now）
  var beatRAF = null;
  var seg = -1;             // 当前呼吸段：0=吸气 1=呼气前段（词停留） 2=呼气末段（词化尘）
  var wordBornAt = 0;       // 词登场时刻，手动模式兜底用
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
    var prevW = W, prevH = H;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * DPR; canvas.height = H * DPR;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    // 全屏切换或旋转后按比例搬移已有微尘，避免它们挤在旧尺寸的范围内
    if (prevW && prevH && (prevW !== W || prevH !== H)) {
      var sx = W / prevW, sy = H / prevH;
      for (var i = 0; i < particles.length; i++) {
        particles[i].x *= sx;
        particles[i].y *= sy;
      }
    }
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
  var audioFadeStarted = false;
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

  function ensureAudioCtx() {
    if (audioCtx) return true;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      audioCtx = new AC();
    } catch (e) {
      audioCtx = null;
      return false;
    }
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
    audioCtx.onstatechange = function () {
      if (audioCtx && audioCtx.state === 'running' && started && !audioFadeStarted) {
        fadeInAudio();
      }
    };
    scheduleBowl();
    return true;
  }

  // 微信/iOS 的音频解锁：必须在真实手势里 resume；失败时等下一次手势重试。
  function unlockAudio() {
    if (!ensureAudioCtx() || !audioCtx) return;
    if (audioCtx.state === 'running') {
      if (started && !audioFadeStarted) fadeInAudio();
      return;
    }
    // 不设“正在恢复”锁：iOS 上 touchstart 的 resume 可能一直 pending，
    // touchend/click 需要能再次尝试；resume() 本身是幂等的。
    try {
      var p = audioCtx.resume();
      if (p && typeof p.then === 'function') {
        p.then(function () {
          if (started && !audioFadeStarted) fadeInAudio();
        }).catch(function () {});
      }
    } catch (e) {}
  }

  function fadeInAudio() {
    if (!ensureAudioCtx() || !audioCtx || !masterGain) return;
    if (audioCtx.state !== 'running') return;
    if (audioFadeStarted) return;
    audioFadeStarted = true;
    var now = audioCtx.currentTime;
    masterGain.gain.cancelScheduledValues(now);
    masterGain.gain.setValueAtTime(masterGain.gain.value, now);
    masterGain.gain.linearRampToValueAtTime(volume * MAX_GAIN, now + 2.5);
  }

  function setupAudioUnlock() {
    // pointerdown 在 iOS 微信里不一定被当成音频手势，touchend/click 更可靠。
    var opts = { once: true, passive: true };
    window.addEventListener('touchstart', unlockAudio, opts);
    window.addEventListener('touchend', unlockAudio, opts);
    window.addEventListener('click', unlockAudio, opts);
    window.addEventListener('pointerup', unlockAudio, opts);

    // 微信 JS Bridge 兜底：部分 iOS 微信需要这个回调才允许出声。
    if (typeof window.WeixinJSBridge !== 'undefined' && window.WeixinJSBridge.invoke) {
      try {
        window.WeixinJSBridge.invoke('getNetworkType', {}, function () { unlockAudio(); });
      } catch (e) {}
    } else {
      document.addEventListener('WeixinJSBridgeReady', function () { unlockAudio(); }, false);
    }
  }
  setupAudioUnlock();

  // ---------- 屏幕常亮：坐忘进行中不让手机自动息屏 ----------
  // 首选标准 Screen Wake Lock，但它要求安全上下文（HTTPS/localhost），
  // 且微信 WebView 多半不提供；因此兜底用「内联静音循环视频」——让系统
  // 认为有媒体在播放，从而不触发自动锁屏（NoSleep 的经典做法）。
  // 视频 1877 字节（2×2、1 秒、无音轨），base64 内联，不产生额外请求。
  var SILENT_MP4 =
    'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAOcbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAA' +
    'AQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
    'AAAAAgAAAsd0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAA' +
    'AAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAIAAAACAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAI/' +
    'bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAA8AAAAPABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRl' +
    'b0hhbmRsZXIAAAAB6m1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAA' +
    'AQAAAapzdGJsAAAAunN0c2QAAAAAAAAAAQAAAKphdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAIAAgBIAAAASAAAAAAA' +
    'AAABFUxhdmM2Mi4xMS4xMDAgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAAMGF2Y0MBQsAe/+EAGGdCwB7ZH4iIwEQAAAMABAAA' +
    'AwDwPFi5IAEABWjLg8sgAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAHEgAAAAAAAAAGHN0dHMAAAAAAAAAAQAAAB4A' +
    'AAIAAAAAFHN0c3MAAAAAAAAAAQAAAAEAAAAcc3RzYwAAAAAAAAABAAAAAQAAAB4AAAABAAAAjHN0c3oAAAAAAAAAAAAAAB4A' +
    'AAKDAAAACQAAAAoAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkA' +
    'AAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAJAAAACQAAAAkAAAAUc3RjbwAAAAAAAAABAAADzAAAAGF1' +
    'ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRh' +
    'AAAAAQAAAABMYXZmNjIuMy4xMDAAAAAIZnJlZQAAA5FtZGF0AAACcQYF//9t3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3Jl' +
    'IDE2NSByMzIyMiBiMzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6' +
    'Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFs' +
    'eXNlPTB4MToweDExMSBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3Jhbmdl' +
    'PTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hy' +
    'b21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVj' +
    'aW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0wIHdlaWdo' +
    'dHA9MCBrZXlpbnQ9MjUwIGtleWludF9taW49MjUgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00' +
    'MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlv' +
    'PTEuNDAgYXE9MToxLjAwAIAAAAAKZYiEC/JigACrzgAAAAVBmjgX6gAAAAZBmlQF+oAAAAAFQZpgL9QAAAAFQZqAL9QAAAAF' +
    'QZqgL9QAAAAFQZrAL9QAAAAFQZrgL9QAAAAFQZsAL9QAAAAFQZsgL9QAAAAFQZtAL9QAAAAFQZtgL9QAAAAFQZuAL9QAAAAF' +
    'QZugL9QAAAAFQZvAL9QAAAAFQZvgL9QAAAAFQZoAL9QAAAAFQZogL9QAAAAFQZpAL9QAAAAFQZpgL9QAAAAFQZqAL9QAAAAF' +
    'QZqgL9QAAAAFQZrAL9QAAAAFQZrgL9QAAAAFQZsAL9QAAAAFQZsgL9QAAAAFQZtAL9QAAAAFQZtgL9QAAAAFQZuAK9QAAAAF' +
    'QZugJ9Q=';

  var awakeWanted = false;   // 用户是否正处于坐忘体验中（希望常亮）
  var wakeSentinel = null;
  var wakePending = false;   // 申请中：避免多个手势重复 request
  var silentVideo = null;

  function startSilentVideo() {
    if (silentVideo) {
      var again = silentVideo.play();
      if (again && again.catch) again.catch(function () {});
      return;
    }
    try {
      var v = document.createElement('video');
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.setAttribute('muted', '');
      v.setAttribute('loop', '');
      v.setAttribute('aria-hidden', 'true');
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.src = SILENT_MP4;
      // 不能 display:none / visibility:hidden，否则部分内核会停掉解码。
      // 用 2×2、极低不透明度放在左下角：视觉不可见，但仍在渲染树里播放。
      v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:.01;pointer-events:none;z-index:-1;';
      document.body.appendChild(v);
      silentVideo = v;
      var p = v.play();
      if (p && typeof p.then === 'function') {
        p.catch(function () { /* 手势不足时元素保留，下一次手势/回到前台再试 */ });
      }
    } catch (e) {
      silentVideo = null;
    }
  }

  function stopSilentVideo() {
    if (!silentVideo) return;
    try {
      silentVideo.pause();
      silentVideo.removeAttribute('src');
      silentVideo.load();
      if (silentVideo.parentNode) silentVideo.parentNode.removeChild(silentVideo);
    } catch (e) {}
    silentVideo = null;
  }

  function keepAwake() {
    awakeWanted = true;
    if (!started) return;
    if (wakeSentinel || wakePending) return;   // 已有锁或正在申请，不重复
    if (navigator.wakeLock && typeof navigator.wakeLock.request === 'function') {
      wakePending = true;
      try {
        navigator.wakeLock.request('screen').then(function (sentinel) {
          wakePending = false;
          if (!awakeWanted) {        // 申请期间页面已隐藏，直接退回
            try { sentinel.release(); } catch (e) {}
            return;
          }
          wakeSentinel = sentinel;
          sentinel.addEventListener('release', function () {
            wakeSentinel = null;   // 系统可能因切后台/省电收回，回前台会重新申请
          });
          stopSilentVideo();       // 原生锁生效，就不需要视频兜底了
        }).catch(function () {
          wakePending = false;
          startSilentVideo();      // 非 HTTPS / 无权限 / 省电模式 → 降级
        });
        return;
      } catch (e) {
        wakePending = false;
      }
    }
    startSilentVideo();
  }

  function stopAwake(clearIntent) {
    if (clearIntent) awakeWanted = false;
    wakePending = false;
    if (wakeSentinel) {
      try { wakeSentinel.release(); } catch (e) {}
      wakeSentinel = null;
    }
    stopSilentVideo();
  }

  // 视频被暂停（手势不足、系统策略）时，在下一次手势里补一次
  function retryAwake() {
    if (!awakeWanted || wakeSentinel) return;
    if (silentVideo) {
      if (silentVideo.paused) {
        var p = silentVideo.play();
        if (p && p.catch) p.catch(function () {});
      }
      return;
    }
    keepAwake();
  }

  window.addEventListener('touchstart', retryAwake, { passive: true });
  window.addEventListener('click', retryAwake);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      if (awakeWanted) keepAwake();          // 切回来重新申请
    } else {
      stopAwake(false);                      // 后台先放开，省电；意图保留
    }
  });
  window.addEventListener('pagehide', function () { stopAwake(false); });
  window.addEventListener('pageshow', function (e) {
    if (e.persisted && awakeWanted) keepAwake();
  });

  function playBowl() {
    if (!audioReady || volume <= 0 || !audioCtx || audioCtx.state !== 'running') return;
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

  // ---------- 右上角开关与音量 ----------
  function applyVolume(animate) {
    if (!ensureAudioCtx() || !masterGain || !audioCtx) return;
    if (audioCtx.state !== 'running') {
      unlockAudio(); // 拖动音量也是用户手势，顺手补一次解锁
      return;
    }
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
    if (showing) unlockAudio(); // 首次展开即解锁，拖动立刻出声
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
    // 切回自动时，若已在呼气末段就立刻化尘；否则等下一拍相位自己接管
    if (autoMode && wordActive && !dissipating && seg === 3) dissipate();
    track(autoMode ? 'mode_auto' : 'mode_manual');
  });

  // ---------- 全屏：支持就给按钮，不支持（iOS Safari / 微信 iOS）就藏起来 ----------
  var fsRoot = document.documentElement;
  var fsRequest = fsRoot.requestFullscreen || fsRoot.webkitRequestFullscreen;
  var fsExit = document.exitFullscreen || document.webkitExitFullscreen;

  function fsElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function syncFsUI() {
    var on = !!fsElement();
    fsRoot.classList.toggle('is-fullscreen', on);
    if (fsBtn) fsBtn.setAttribute('aria-label', on ? '退出全屏' : '全屏');
    requestAnimationFrame(resize); // 浏览器工具栏收起/展开，画布需重新量尺寸
  }

  if (fsBtn) {
    if (fsRequest) {
      fsBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        closeVolumePanel();
        unlockAudio(); // 顺手借这次手势解锁音频，微信里少一次试错
        var p = fsElement() ? (fsExit && fsExit.call(document)) : fsRequest.call(fsRoot);
        if (p && p.catch) p.catch(function () {}); // 被 WebView 拒绝时静默，不弹错误
      });
    } else {
      fsBtn.style.display = 'none'; // 没有全屏能力就不留一个没反应的按钮
    }
  }
  document.addEventListener('fullscreenchange', syncFsUI);
  document.addEventListener('webkitfullscreenchange', syncFsUI);

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

  // ---------- 呼吸节拍：绝对时钟驱动，环永不因文字停下 ----------
  // 相位 p = (now - beatStart) % 10000：0~4000 吸气（环张开），4000~10000 呼气（环收拢）。
  // 环的位置每帧由相位直接算出，所以词的出现、停留、消散都不可能让它减速或暂停。
  var RING_MIN = 0.82, RING_MAX = 1.14;
  var OP_MIN = 0.78, OP_MAX = 1;

  function phaseAt(ts) {
    var d = (ts - beatStart) % CYCLE_MS;
    return d < 0 ? d + CYCLE_MS : d;
  }

  // 0 = 最内（呼尽），1 = 最外（吸满）
  function ringLevel(p) {
    return p < INHALE_MS ? p / INHALE_MS : 1 - (p - INHALE_MS) / EXHALE_MS;
  }

  function paintRing(p) {
    var t = ringLevel(p);
    ring.style.transform = 'scale(' + (RING_MIN + (RING_MAX - RING_MIN) * t).toFixed(4) + ')';
    ring.style.opacity = (OP_MIN + (OP_MAX - OP_MIN) * t).toFixed(3);
  }

  // 核心词登场：踩在吸气顶点上，随后陪用户走完整个呼气
  function spawnWord(ts) {
    if (!started || wordActive) return;
    wordActive = true;
    wordBornAt = ts;
    wordIndex = (wordIndex + 1) % WORDS.length;
    setText(WORDS[wordIndex], 'word');
    showText();
    syncHint(); // 手动模式下同时浮出“长按”
  }

  // 化尘：文字渐隐 + 微尘渗出，2.5s 后正好与环触底重合
  function dissipate() {
    if (!wordActive || dissipating) return;
    dissipating = true;
    syncHint(); // 开始消散即隐藏“长按”，避免提示悬在渐隐文字下
    cancelPress();
    dissolveWord();
    track('dissipate_done');
    textMain.classList.add('dissolving');
  }

  // 收尾统一交给相位边界，不再用 settimeout 追着呼吸跑
  function clearWord() {
    clearInterval(seepTimer); seepTimer = null;
    dissolveOrigin = null;
    textMain.classList.remove('dissolving');
    wordActive = false;
    dissipating = false;
    syncHint();
  }

  function enterSeg(s, ts) {
    if (s === 0) {
      // 吸气：手动模式下词还在等长按，就把环心让给它——环照常张开
      if (wordActive && !dissipating && !autoMode) return;
      if (wordActive) clearWord();
      setText('吸', 'breath');
      showText();
      return;
    }
    if (s === 1) {
      // 吸气最后 1.1s：让“吸”先淡出，环吸满时环心正好是空的
      if (!wordActive) hideText();
      return;
    }
    if (s === 2) {
      // 吸气顶点：词淡入，陪用户走完整个呼气；首轮雾未散时不打扰，只留呼吸
      if (!wordActive && state === 'hold') spawnWord(ts);
      return;
    }
    // 呼气末段：自动模式随环收拢化尘；手动模式等长按，超过三轮由兜底处理
    if (autoMode) dissipate();
  }

  function beatTick(ts) {
    beatRAF = requestAnimationFrame(beatTick);
    if (!started) return;
    var p = phaseAt(ts);
    paintRing(p); // 环只认相位，任何文字状态都不影响这一行

    var s = p < WORD_PREPARE_AT ? 0
          : p < INHALE_MS ? 1
          : p < WORD_DISSOLVE_AT ? 2 : 3;
    if (s !== seg) { seg = s; enterSeg(s, ts); }

    // 手动模式兜底：一直没人长按，三轮呼吸后自己化尘
    if (wordActive && !dissipating && !autoMode && ts - wordBornAt >= MANUAL_MAX_MS) dissipate();
  }

  function startBeat() {
    beatStart = performance.now();
    seg = -1;
    if (!beatRAF) beatRAF = requestAnimationFrame(beatTick);
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
    // 必须尽早、且在真实手势里解锁；不要先跑 1000 个粒子再初始化音频。
    unlockAudio();
    keepAwake();   // 坐忘期间保持屏幕常亮，避免深呼吸到一半黑屏
    spawnMotes(1000);
    state = 'breath';
    switchStage(null, stageBreath);
    hideText(); // “轻触开始”淡出
    setTimeout(startBeat, FADE); // 等提示淡尽再起拍，之后节拍不再被任何东西打断

    // 一整轮呼吸（10s）后雾散、山谷浮现，且正好落在吸气起点上
    setTimeout(function () {
      state = 'hold';
      switchStage(stageBreath, stageHold);
      valley.classList.add('show');
      if (!fogReported) { fogReported = true; track('fog_revealed'); }
      // 不再单独排“第一个词”：词只在吸气顶点登场，相位会自己送到
    }, FADE + CYCLE_MS);
  }

  // ---------- 交互绑定 ----------
  function closeVolumePanel() {
    if (!volumeWrap.classList.contains('show')) return;
    volumeWrap.classList.remove('show');
    volumeWrap.setAttribute('aria-hidden', 'true');
    soundBtn.setAttribute('aria-expanded', 'false');
  }

  function onPressDown(e) {
    if (e.target && e.target.closest && e.target.closest('#volume-wrap, #sound-toggle, #fs-toggle')) return;
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
