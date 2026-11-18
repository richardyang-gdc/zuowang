'use strict';
// 坐忘 MVP · 零依赖服务端
// 只做三件事：托管 public 静态页 / 收集匿名埋点 / 现算统计数据

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1'; // 仅本机可访问，测试更安全
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const LOG = path.join(DATA_DIR, 'visits.jsonl');
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

// ---- 初始化数据文件（只在项目目录内）----
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(LOG)) fs.writeFileSync(LOG, '', 'utf8');

// ---- 串行写队列，避免并发 append 丢数据 ----
let writeChain = Promise.resolve();
function appendEvent(record) {
  const line = JSON.stringify(record) + '\n';
  writeChain = writeChain.then(() => new Promise((resolve, reject) => {
    fs.appendFile(LOG, line, 'utf8', (err) => err ? reject(err) : resolve());
  }));
  return writeChain;
}

function readEvents() {
  const raw = fs.readFileSync(LOG, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* 跳过坏行 */ }
  }
  return out;
}

// ---- MIME ----
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---- 统计算法 ----
function computeStats(events) {
  const now = Date.now();
  // 只认合法的匿名 ID 与时间戳
  const valid = events.filter(e =>
    e && typeof e.id === 'string' && /^[0-9a-f-]{8,}$/i.test(e.id) &&
    Number.isFinite(e.ts)
  );

  const views = valid.filter(e => e.event === 'page_view');
  const pv = views.length;

  // 按 id 聚合
  const byId = new Map();
  for (const e of valid) {
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }

  const uv = views.filter(e => true).reduce((set, e) => set.add(e.id), new Set()).size;

  // 来源聚合（按首次 page_view 归属）
  const source = {};
  const firstViewTs = new Map();
  for (const e of views) {
    const t = e.ts;
    if (!firstViewTs.has(e.id) || t < firstViewTs.get(e.id)) firstViewTs.set(e.id, t);
  }
  for (const [id, t] of firstViewTs) {
    const ev = views.find(v => v.id === id && v.ts === t);
    const src = (ev && ev.src) || 'direct';
    source[src] = (source[src] || 0) + 1;
  }

  // 漏斗：去重人数
  const reached = (evt) => new Set(valid.filter(e => e.event === evt).map(e => e.id)).size;
  const funnel = {
    entered: uv,
    fog_revealed: reached('fog_revealed'),
    dissipate_done: reached('dissipate_done'),
    exited: reached('exit'),
  };
  const funnelRate = {
    fog_revealed: uv ? +(funnel.fog_revealed / uv * 100).toFixed(1) : 0,
    dissipate_done: uv ? +(funnel.dissipate_done / uv * 100).toFixed(1) : 0,
    exited: uv ? +(funnel.exited / uv * 100).toFixed(1) : 0,
  };

  // 停留时长（秒）
  const exits = valid.filter(e => e.event === 'exit' && Number.isFinite(e.duration) && e.duration >= 0);
  const avgDwellSec = exits.length
    ? +(exits.reduce((s, e) => s + e.duration, 0) / exits.length / 1000).toFixed(1)
    : 0;

  // 7 日复访：只算首访已满 7 天的人；窗口 (first, first+7d]
  let mature = 0, returned = 0;
  for (const [id, first] of firstViewTs) {
    if (first > now - SEVEN_DAYS) continue; // 未满 7 天，暂不判定
    mature++;
    const again = views.some(v => v.id === id && v.ts > first && v.ts <= first + SEVEN_DAYS);
    if (again) returned++;
  }
  const day7 = {
    mature,
    returned,
    rate: mature ? +(returned / mature * 100).toFixed(1) : 0,
  };

  // 即时静心代理：停留 >3s 占比
  const over3s = exits.filter(e => e.duration > 3000).length;
  const calm3s = exits.length ? +(over3s / exits.length * 100).toFixed(1) : 0;

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    pv,
    uv,
    avg_dwell_sec: avgDwellSec,
    calm_3s_rate: calm3s,
    source,
    funnel,
    funnel_rate_pct: funnelRate,
    day7_return: day7,
  };
}

// ---- 路由 ----
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}`);
    const p = url.pathname;

    if (req.method === 'GET' && p === '/api/health') {
      return sendJSON(res, 200, { ok: true, service: 'zuowang-mvp', time: Date.now() });
    }

    if (req.method === 'POST' && p === '/api/pv') {
      const raw = await readBody(req);
      let data;
      try { data = JSON.parse(raw); } catch (_) { return sendJSON(res, 400, { ok: false, error: 'bad json' }); }
      const id = data && data.id;
      if (typeof id !== 'string' || !/^[0-9a-f-]{8,}$/i.test(id)) {
        return sendJSON(res, 400, { ok: false, error: 'bad id' });
      }
      const allowed = new Set(['page_view', 'fog_revealed', 'dissipate_done', 'exit']);
      if (!allowed.has(data.event)) return sendJSON(res, 400, { ok: false, error: 'bad event' });
      await appendEvent({
        id,
        ts: Number.isFinite(data.ts) ? data.ts : Date.now(),
        event: data.event,
        src: typeof data.src === 'string' ? data.src.slice(0, 32) : 'direct',
        duration: Number.isFinite(data.duration) ? data.duration : undefined,
      });
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'GET' && p === '/api/stats') {
      return sendJSON(res, 200, computeStats(readEvents()));
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const file = path.join(PUBLIC, 'index.html');
      const body = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return res.end(body);
    }

    if (req.method === 'GET') {
      // 路径穿越防护：解析后必须仍在 public 目录内
      const target = path.resolve(PUBLIC, '.' + p);
      if (target !== PUBLIC && !target.startsWith(PUBLIC + path.sep)) {
        return sendJSON(res, 403, { ok: false, error: 'forbidden' });
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found');
      }
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(target));
    }

    return sendJSON(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    return sendJSON(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n[启动失败] 端口 ${PORT} 已被占用。`);
    console.error('处理方式（二选一）：');
    console.error(`  1) 结束占用者：lsof -nP -iTCP:${PORT} -sTCP:LISTEN  然后 kill <PID>`);
    console.error(`  2) 换端口启动：PORT=3001 npm start\n`);
    process.exit(1);
  }
  console.error('[服务异常]', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('坐忘 MVP 已启动');
  console.log(`  本地访问: http://${HOST}:${PORT}`);
  console.log(`  统计数据: http://${HOST}:${PORT}/api/stats`);
  console.log('  按 Ctrl+C 停止');
});
