const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const root = process.argv[2], port = +process.argv[3];
const types = { '.html':'text/html; charset=utf-8', '.js':'application/javascript; charset=utf-8', '.mjs':'application/javascript', '.css':'text/css; charset=utf-8', '.json':'application/json', '.webmanifest':'application/manifest+json', '.png':'image/png', '.jpg':'image/jpeg', '.svg':'image/svg+xml' };
const gz = new Set(['.html','.js','.mjs','.css','.json','.webmanifest','.svg']);
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  const ext = path.extname(f); let body = fs.readFileSync(f);
  const etag = 'W/"' + crypto.createHash('md5').update(body).digest('hex').slice(0,12) + '"';
  const h = { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'max-age=600', etag, 'access-control-allow-origin': '*', vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, h); return res.end(); }
  if (gz.has(ext) && /gzip/.test(req.headers['accept-encoding'] || '')) { body = zlib.gzipSync(body, { level: 6 }); h['content-encoding'] = 'gzip'; }
  h['content-length'] = body.length;
  res.writeHead(200, h); res.end(body);
}).listen(port, () => console.log('listening', port));
