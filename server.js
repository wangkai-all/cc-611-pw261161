'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { Store, HttpError } = require('./src/store');
const { EngineError } = require('./src/engine');
const sampleData = require('./src/sampleData');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendError(res, err) {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.message });
  } else if (err instanceof EngineError) {
    sendJson(res, 400, { error: err.message, code: err.code });
  } else {
    sendJson(res, 500, { error: '服务器内部错误' });
    console.error(err);
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', () => reject(new HttpError(400, '读取请求体失败')));
  });
}

function serveStatic(res, filePath) {
  const normalized = path.normalize(filePath);
  if (!normalized.startsWith(PUBLIC_DIR)) {
    throw new HttpError(403, '禁止访问');
  }
  let content;
  try {
    content = fs.readFileSync(normalized);
  } catch {
    throw new HttpError(404, '静态资源不存在');
  }
  const type = CONTENT_TYPES[path.extname(normalized)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  res.end(content);
}

async function route(req, res, store) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  if (method === 'GET' && (p === '/app.js' || p === '/style.css')) {
    return serveStatic(res, path.join(PUBLIC_DIR, p));
  }

  if (method === 'GET' && p === '/api/state') {
    return sendJson(res, 200, store.state());
  }
  if (method === 'POST' && p === '/api/analyze') {
    const body = await readJson(req);
    const m = body.method === undefined ? undefined : body.method;
    if (m !== undefined && typeof m !== 'string') throw new HttpError(400, 'method 必须是字符串');
    return sendJson(res, 200, store.analyze(m));
  }
  if (method === 'POST' && p === '/api/revoke') {
    const body = await readJson(req);
    if (!body || typeof body.workOrderId !== 'string' || body.workOrderId === '') {
      throw new HttpError(400, '请求体必须包含 workOrderId 字符串');
    }
    return sendJson(res, 200, store.revoke(body.workOrderId));
  }
  if (method === 'POST' && p === '/api/reset') {
    store.reset();
    return sendJson(res, 200, { ok: true, state: store.state() });
  }
  if (method === 'GET' && p === '/api/overlap') {
    const m = url.searchParams.get('method');
    return sendJson(res, 200, store.overlap(m || undefined));
  }
  if (method === 'GET' && p === '/api/reports') {
    return sendJson(res, 200, store.reportList());
  }
  const reportMatch = p.match(/^\/api\/reports\/([\w-]+)$/);
  if (method === 'GET' && reportMatch) {
    return sendJson(res, 200, store.getReport(reportMatch[1]));
  }

  throw new HttpError(404, `接口不存在: ${method} ${p}`);
}

function createServer(store) {
  return http.createServer((req, res) => {
    route(req, res, store).catch((err) => {
      if (!res.headersSent) sendError(res, err);
      else res.end();
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`PORT 非法: ${process.env.PORT}`);
    process.exit(1);
  }
  const store = new Store(sampleData);
  createServer(store).listen(port, '127.0.0.1', () => {
    console.log(`工单投入归属服务已启动: http://127.0.0.1:${port}`);
  });
}

module.exports = { createServer };
