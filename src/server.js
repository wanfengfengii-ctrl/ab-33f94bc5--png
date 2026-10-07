// HTTP service exposing POST /api/png/audit and GET /healthz.
// Zero third-party dependencies: Node's built-in http, zlib and crypto.

import http from 'node:http';
import { auditPng, PngAuditError, MAX_BODY_BYTES } from './png.js';

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

// JSON error shape: { error: { code, message, chunk?, line? } }
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, code, message, extra = {}) {
  sendJson(res, status, { error: { code, message, ...extra } });
}

async function handleAudit(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendError(res, 405, 'METHOD_NOT_ALLOWED', 'use POST /api/png/audit');
    return;
  }

  // The instrument export must be declared as image/png.
  const mediaType = (req.headers['content-type'] || '')
    .split(';')[0].trim().toLowerCase();
  if (mediaType !== 'image/png') {
    sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE',
      'Content-Type must be image/png');
    return;
  }

  // Reject an oversized declared body up front; still enforce a hard cap
  // while reading in case Content-Length is absent or wrong.
  const declaredLength = req.headers['content-length']
    ? Number.parseInt(req.headers['content-length'], 10)
    : null;
  if (declaredLength !== null) {
    if (Number.isNaN(declaredLength) || declaredLength < 0) {
      sendError(res, 400, 'INVALID_CONTENT_LENGTH', 'invalid Content-Length');
      req.resume();
      return;
    }
    if (declaredLength > MAX_BODY_BYTES) {
      sendError(res, 413, 'BODY_TOO_LARGE',
        `body must not exceed ${MAX_BODY_BYTES} bytes (8 MiB)`);
      req.resume();
      return;
    }
  }

  // Content-Encoding/Transfer-Encoding tricks must not mask the raw bytes.
  if (req.headers['content-encoding']) {
    sendError(res, 415, 'UNSUPPORTED_MEDIA_TYPE',
      'Content-Encoding is not accepted; send raw PNG bytes');
    req.resume();
    return;
  }

  const chunks = [];
  let received = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      tooLarge = true;
      break;
    }
    chunks.push(chunk);
  }
  if (tooLarge) {
    req.resume();
    sendError(res, 413, 'BODY_TOO_LARGE',
      `body must not exceed ${MAX_BODY_BYTES} bytes (8 MiB)`);
    return;
  }
  if (received === 0) {
    sendError(res, 400, 'EMPTY_BODY', 'empty request body');
    return;
  }

  let result;
  try {
    result = await auditPng(Buffer.concat(chunks, received));
  } catch (err) {
    if (err instanceof PngAuditError) {
      const extra = {};
      if (err.chunkNumber !== null) extra.chunk = err.chunkNumber;
      if (err.lineNumber !== null) extra.line = err.lineNumber;
      sendError(res, 422, err.code, err.message, extra);
      return;
    }
    sendError(res, 500, 'INTERNAL_ERROR', 'audit failed unexpectedly');
    return;
  }

  sendJson(res, 200, result);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz' && req.method === 'GET') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  if (url.pathname === '/api/png/audit') {
    handleAudit(req, res).catch(() => {
      if (!res.headersSent) {
        sendError(res, 500, 'INTERNAL_ERROR', 'audit failed unexpectedly');
      } else {
        res.end();
      }
    });
    return;
  }
  sendError(res, 404, 'NOT_FOUND', `unknown route ${url.pathname}`);
});

server.listen(PORT, HOST, () => {
  console.log(`png-audit API listening on http://${HOST}:${PORT}`);
});

function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  // Do not wait indefinitely on idle keep-alive sockets.
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
