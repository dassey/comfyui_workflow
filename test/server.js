// A stand-in for "somebody else's website": serves pages and videos with
// configurable Range / CORS behaviour, plus a local CORS relay, so the e2e
// suite can exercise every network path the extractor has to cope with.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { MEDIA_DIR } from './fixtures.js';

export const PORT = Number(process.env.TEST_ORIGIN_PORT || 8099);
export const ORIGIN = `http://localhost:${PORT}`;

const PAGES = {
  '/page/source-tag': `<!doctype html><html><head><title>Render</title></head><body>
    <h1>My render</h1>
    <video controls poster="/thumb.jpg"><source src="/render.mp4" type="video/mp4"></video>
  </body></html>`,

  '/page/og-meta': `<!doctype html><html><head>
    <meta property="og:video" content="${ORIGIN}/render.mp4">
    <meta property="og:image" content="${ORIGIN}/thumb.jpg">
  </head><body>og only</body></html>`,

  // "/" escaped as "\/", the way inline JSON blobs usually carry a URL
  '/page/escaped-json': `<!doctype html><html><head><title>App</title></head><body>
    <div id="root"></div>
    <script>window.__DATA__ = {"post":{"media":{"url":"http:\\/\\/localhost:${PORT}\\/render.mp4","w":1280}}};</script>
  </body></html>`,

  '/page/relative-base': `<!doctype html><html><head><base href="${ORIGIN}/"></head><body>
    <video src="render.mp4"></video>
  </body></html>`,

  '/page/multiple': `<!doctype html><html><head>
    <meta property="og:video" content="${ORIGIN}/render.mp4">
  </head><body>
    <video><source src="/render-faststart.mp4"></video>
    <a href="/plain.mp4">download</a>
  </body></html>`,

  '/page/none': `<!doctype html><html><body><p>Just text, no video here.</p>
    <img src="/thumb.jpg"></body></html>`,

  '/page/norange': `<!doctype html><html><body>
    <video src="/norange/render.mp4"></video></body></html>`,

  '/page/nocors': `<!doctype html><html><body>
    <video src="/nocors/render.mp4"></video></body></html>`,
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body || undefined);
}

// A client that cancels mid-stream must not surface as an unhandled error.
function pipe(stream, res) {
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

function serveVideo(req, res, name, { allowRange, cors }) {
  const file = path.join(MEDIA_DIR, path.basename(name));
  if (!fs.existsSync(file)) return send(res, 404, {}, 'no such video');

  const size = fs.statSync(file).size;
  const headers = { 'Content-Type': 'video/mp4' };
  if (cors) {
    headers['Access-Control-Allow-Origin'] = '*';
    headers['Access-Control-Expose-Headers'] =
      'content-range, content-length, accept-ranges';
  }
  if (allowRange) headers['Accept-Ranges'] = 'bytes';

  const range =
    allowRange && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      return send(
        res,
        416,
        { ...headers, 'Content-Range': `bytes */${size}` },
        '',
      );
    }
    // writeHead, not send: the response must stay open for the pipe.
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    });
    return pipe(fs.createReadStream(file, { start, end }), res);
  }

  res.writeHead(200, { ...headers, 'Content-Length': String(size) });
  pipe(fs.createReadStream(file), res);
}

async function handle(req, res) {
  const url = new URL(req.url, ORIGIN);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    return send(
      res,
      204,
      {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'range',
        'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
      },
      '',
    );
  }

  if (pathname === '/relay') {
    const target = url.searchParams.get('target');
    if (!target) return send(res, 400, {}, 'missing target');
    const upstream = await fetch(target, {
      headers: req.headers.range ? { Range: req.headers.range } : {},
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers':
        'content-range, content-length, accept-ranges',
      'Content-Type':
        upstream.headers.get('content-type') || 'application/octet-stream',
      'Content-Length': String(body.length),
    };
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) headers['Content-Range'] = contentRange;
    return send(res, upstream.status, headers, body);
  }

  if (PAGES[pathname]) {
    return send(
      res,
      200,
      {
        'Content-Type': 'text/html; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
      PAGES[pathname],
    );
  }

  if (pathname.startsWith('/norange/')) {
    return serveVideo(req, res, pathname, { allowRange: false, cors: true });
  }
  if (pathname.startsWith('/nocors/')) {
    return serveVideo(req, res, pathname, { allowRange: true, cors: false });
  }
  if (pathname.endsWith('.mp4')) {
    return serveVideo(req, res, pathname, { allowRange: true, cors: true });
  }
  if (pathname === '/thumb.jpg') {
    return send(res, 200, { 'Content-Type': 'image/jpeg' }, Buffer.alloc(64));
  }

  send(res, 404, { 'Access-Control-Allow-Origin': '*' }, 'not found');
}

export function startOrigin() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      // An aborted relay fetch must not take the whole test origin down.
      if (!res.headersSent) {
        send(res, 502, { 'Access-Control-Allow-Origin': '*' }, 'relay error');
      } else {
        res.end();
      }
      console.error('request failed:', req.url, err.message);
    });
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startOrigin().then(() => console.log(`test origin on ${ORIGIN}`));
}
