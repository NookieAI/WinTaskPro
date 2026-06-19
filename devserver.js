// devserver.js — WinTaskPro development file server
// Started automatically by `npm run dev` via tauri.conf.json beforeDevCommand.
// Serves the ./src directory on http://localhost:1420
//
// WHY TWO SERVERS:
// `server.listen(PORT)` without a host binds to `::` (IPv6 wildcard).
// On Windows, whether `::` also accepts IPv4 connections depends on the
// IPV6_V6ONLY socket option — on some machines it does (dual-stack),
// on others it only accepts IPv6. Since `localhost` can resolve to either
// 127.0.0.1 (IPv4) or ::1 (IPv6) depending on the application, we listen
// on BOTH addresses explicitly so WebView2 can connect regardless.
//
// GOTCHA: If port 1420 is already held (previous session not fully killed):
//   netstat -ano | findstr :1420
//   taskkill /PID <pid> /F

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = 1420;
const ROOT = path.join(__dirname, 'src');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
};

function handler(req, res) {
  const urlPath  = (req.url === '/' ? '/index.html' : req.url).split('?')[0];
  const filePath = path.normalize(path.join(ROOT, urlPath));

  if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      const status = err.code === 'ENOENT' ? 404 : 500;
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(`${status} ${err.code === 'ENOENT' ? 'Not Found' : 'Server Error'}: ${urlPath}`);
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// Print "Serving" as soon as the first server is ready so Tauri's
// beforeDevCommand watcher can proceed to start the cargo build.
let announced = false;
function onListening(host) {
  if (!announced) {
    console.log(`[devserver] Serving ./src on http://localhost:${PORT}`);
    announced = true;
  }
  console.log(`[devserver]   bound to http://${host}:${PORT}`);
}

function makeServer(host, exitOnAddrinuse) {
  const srv = http.createServer(handler);
  srv.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[devserver] ERROR: ${host}:${PORT} already in use.`);
      console.error(`[devserver]   netstat -ano | findstr :${PORT}   then   taskkill /PID <pid> /F`);
      if (exitOnAddrinuse) process.exit(1);
    } else {
      console.error(`[devserver] ${host} error:`, err.message);
    }
  });
  srv.listen(PORT, host, () => onListening(host));
  return srv;
}

// IPv4 — for WebView2 resolving localhost → 127.0.0.1
makeServer('127.0.0.1', true);

// IPv6 — for WebView2 resolving localhost → ::1
// Non-fatal if the machine has no IPv6 stack
makeServer('::1', false);
