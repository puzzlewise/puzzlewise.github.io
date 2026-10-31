// Static server with a SHARED bandwidth-limited link + per-request latency, a stub image proxy and a caching Unsplash CDN mirror.
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const root = process.argv[2], port = +process.argv[3];
let RATE = +(process.env.RATE || 188743); // bytes/s shared (Slow 4G = 1.6Mbps*0.9)
let LAT = +(process.env.LAT || 562.5);
const pool = JSON.parse(fs.readFileSync('/Users/bot/src/puzzle/src/images/backup-pool.json', 'utf8'));
const cacheDir = '/tmp/perf-audit/load/cdn-cache'; fs.mkdirSync(cacheDir, { recursive: true });
const types = { '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.mjs':'application/javascript', '.css':'text/css; charset=utf-8', '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml' };
const gzx = new Set(['.html','.js','.mjs','.css','.json','.webmanifest','.svg']);
const log = [];
const t0 = Date.now();
// shared link scheduler
const active = new Set();
setInterval(() => {
  if (!active.size) return;
  const budget = RATE / 100; // 10ms tick
  const share = Math.max(1, Math.floor(budget / active.size));
  for (const job of [...active]) {
    const n = Math.min(share, job.buf.length - job.off);
    job.res.write(job.buf.subarray(job.off, job.off + n)); job.off += n;
    if (job.off >= job.buf.length) { job.res.end(); active.delete(job); log.push([job.url, job.start, Date.now() - t0, job.buf.length]); }
  }
}, 10);
function send(req, res, status, headers, body) {
  const start = Date.now() - t0;
  setTimeout(() => {
    headers['content-length'] = body.length;
    res.writeHead(status, headers);
    if (!body.length || RATE <= 0) { res.end(body); return; }
    active.add({ res, buf: body, off: 0, url: req.url.slice(0, 80), start });
  }, LAT);
}
function photos(orientation) {
  return pool.filter((p) => p.orientation === orientation).slice(0, 30).map((p) => ({
    urls: { regular: p.imageUrl.replace('https://images.unsplash.com', `http://localhost:${port}/cdn`), full: p.imageUrl, small: p.thumbUrl.replace('https://images.unsplash.com', `http://localhost:${port}/cdn`) },
    width: p.width, height: p.height,
    user: { name: p.photographerName, links: { html: p.photographerUrl.split('?')[0] } },
    links: { html: p.photoUrl.split('?')[0], download_location: p.downloadLocation },
    alt_description: p.description ?? null,
  }));
}
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__log') { res.end(JSON.stringify(log)); log.length = 0; return; }
  if (u.pathname === '/__cfg') { RATE = +u.searchParams.get('rate'); LAT = +u.searchParams.get('lat'); res.end('ok'); return; }
  const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-total' };
  if (u.pathname.startsWith('/proxy/download')) return send(req, res, 200, { ...cors, 'content-type': 'application/json' }, Buffer.from('{}'));
  if (u.pathname.startsWith('/proxy/')) {
    const o = u.searchParams.get('orientation') || 'landscape';
    const body = u.pathname.includes('/search') ? { results: photos(o), total_pages: 50 } : photos(o);
    return send(req, res, 200, { ...cors, 'content-type': 'application/json', 'x-total': '1500' }, Buffer.from(JSON.stringify(body)));
  }
  if (u.pathname.startsWith('/cdn/')) {
    const real = 'https://images.unsplash.com/' + req.url.slice(5);
    const key = path.join(cacheDir, crypto.createHash('md5').update(real).digest('hex'));
    if (!fs.existsSync(key)) { const r = await fetch(real); fs.writeFileSync(key, Buffer.from(await r.arrayBuffer())); }
    return send(req, res, 200, { 'content-type': 'image/jpeg', 'cache-control': 'max-age=31536000', ...cors }, fs.readFileSync(key));
  }
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  const ext = path.extname(f); let body = fs.readFileSync(f);
  const etag = 'W/"' + crypto.createHash('md5').update(body).digest('hex').slice(0, 12) + '"';
  const h = { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'max-age=600', etag, vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === etag) return send(req, res, 304, h, Buffer.alloc(0));
  if (gzx.has(ext) && /gzip/.test(req.headers['accept-encoding'] || '')) { body = zlib.gzipSync(body, { level: 6 }); h['content-encoding'] = 'gzip'; }
  send(req, res, 200, h, body);
}).listen(port, () => console.log('listening', port));
