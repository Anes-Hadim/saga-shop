'use strict';
/** Tiny routing + JSON helpers shared by the services. No framework. */
const http = require('node:http');

function body(req, limit = 1 << 18) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(Object.assign(new Error('payload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function service(name, routes) {
  const srv = http.createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const handler = routes[`${req.method} ${path}`];
    const send = (code, obj) => {
      const b = Buffer.from(JSON.stringify(obj));
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length });
      res.end(b);
    };
    if (path === '/healthz') return send(200, { ok: true, service: name });
    if (!handler) return send(404, { error: `no route ${req.method} ${path}` });
    try {
      const payload = req.method === 'GET' ? {} : await body(req);
      const out = await handler(payload, req);
      send(out.status ?? 200, out.body ?? out);
    } catch (err) {
      send(err.status || 500, { error: err.message });
    }
  });
  srv.serviceName = name;
  srv.start = (port = 0) => new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv.address().port)));
  srv.stop = () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); });
  return srv;
}

/** POST JSON and reject on a non-2xx, so a saga step fails on an HTTP error. */
async function post(base, path, payload, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw Object.assign(new Error(parsed.error || `HTTP ${res.status}`), { status: res.status, body: parsed });
  }
  return parsed;
}

module.exports = { service, post, body };
