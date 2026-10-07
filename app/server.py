"""HTTP front-end for the PNG audit pipeline (standard library only).

Endpoints:
    GET  /health           -> liveness probe used by Docker healthchecks
    POST /api/png/audit    -> strict PNG audit, body must be image/png
"""

from __future__ import annotations

import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .pngaudit import MAX_BODY_BYTES, PngAuditError, audit_png

AUDIT_PATH = "/api/png/audit"
HEALTH_PATH = "/health"


class AuditHandler(BaseHTTPRequestHandler):
    server_version = "PngAudit/1.0"
    protocol_version = "HTTP/1.1"

    # -- helpers ---------------------------------------------------------

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, code, message, **extra):
        error = {"code": code, "message": message}
        error.update(extra)
        self._json(status, {"ok": False, "error": error})

    def _drain(self, length):
        """Discard up to `length` body bytes so the connection stays sane."""
        remaining = length
        while remaining > 0:
            chunk = self.rfile.read(min(65536, remaining))
            if not chunk:
                break
            remaining -= len(chunk)

    # -- routing ---------------------------------------------------------

    def do_GET(self):
        if self.path == HEALTH_PATH:
            self._json(200, {"status": "ok"})
        elif self.path == AUDIT_PATH:
            self._error(405, "METHOD_NOT_ALLOWED",
                        "use POST with an image/png body")
        else:
            self._error(404, "NOT_FOUND", "unknown endpoint")

    def do_POST(self):
        if self.path != AUDIT_PATH:
            self._error(404, "NOT_FOUND", "unknown endpoint")
            return

        content_type = (self.headers.get("Content-Type") or "")
        content_type = content_type.split(";")[0].strip().lower()
        if content_type != "image/png":
            # The unread body would desync a keep-alive connection.
            self.close_connection = True
            self._error(415, "UNSUPPORTED_MEDIA_TYPE",
                        "Content-Type must be image/png")
            return

        length_header = self.headers.get("Content-Length")
        if length_header is None:
            self.close_connection = True
            self._error(411, "LENGTH_REQUIRED",
                        "Content-Length header is required")
            return
        try:
            length = int(length_header)
        except ValueError:
            self.close_connection = True
            self._error(400, "BAD_CONTENT_LENGTH",
                        "Content-Length is not an integer")
            return
        if length < 0:
            self.close_connection = True
            self._error(400, "BAD_CONTENT_LENGTH",
                        "Content-Length must not be negative")
            return
        if length > MAX_BODY_BYTES:
            self._drain(length)
            self._error(413, "PAYLOAD_TOO_LARGE",
                        "body must be at most %d bytes (8 MiB)"
                        % MAX_BODY_BYTES)
            return

        body = self.rfile.read(length)
        if len(body) != length:
            self._error(400, "TRUNCATED_BODY",
                        "connection closed before the full body was received")
            return

        try:
            result = audit_png(body)
        except PngAuditError as exc:
            self._json(400, {"ok": False, "error": exc.to_dict()})
            return
        self._json(200, result)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    port = int(os.environ.get("PORT", "8000"))
    server = ThreadingHTTPServer(("0.0.0.0", port), AuditHandler)
    print("png-audit listening on 0.0.0.0:%d" % port, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
