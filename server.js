// Tiny static file server for local preview of the BJmeem store and admin.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 5173;
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
};

http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';
  let file = path.join(ROOT, url);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

  // /admin and /admin/ both resolve to /admin/index.html
  try {
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
      file = path.join(file, 'index.html');
    }
  } catch { /* fall through to 404 */ }

  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}).listen(PORT, () => console.log(`BJmeem preview running on http://localhost:${PORT}`));
