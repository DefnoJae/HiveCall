// Minimal static preview server for HiveCall (mimics vercel.json rewrites)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'HiveCall-main');
const PORT = process.env.PORT || 8123;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

http
  .createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400);
      return res.end('Bad request');
    }
    if (urlPath.endsWith('/')) urlPath += 'hivecall.html'; // serve app at "/"

    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        // vercel.json: { "rewrites": [{ "source": "/(.*)", "destination": "/hivecall.html" }] }
        return fs.readFile(path.join(ROOT, 'hivecall.html'), (err2, html) => {
          if (err2) {
            res.writeHead(404);
            return res.end('Not found');
          }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(html);
        });
      }
      const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`HiveCall preview running at http://127.0.0.1:${PORT}/hivecall.html`);
  });
