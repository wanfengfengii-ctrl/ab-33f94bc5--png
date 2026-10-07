"""In-process HTTP tests for the audit API."""

from __future__ import annotations

import hashlib
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from app.pngaudit import MAX_BODY_BYTES
from app.server import AuditHandler
from tests.pngsamples import build_png, random_rows


class ServerFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), AuditHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever,
                                      daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%d" % cls.port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def post(self, body, content_type="image/png", path="/api/png/audit"):
        headers = {}
        if content_type is not None:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(self.base + path, data=body,
                                         headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path,
                                        timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())


class HttpApiTests(ServerFixture):
    def test_health(self):
        status, payload = self.get("/health")
        self.assertEqual(status, 200)
        self.assertEqual(payload["status"], "ok")

    def test_audit_valid_png(self):
        rows = random_rows(7, 5, 6, seed=21)
        png = build_png(7, 5, 6, rows, [i % 5 for i in range(5)])
        status, payload = self.post(png)
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["width"], 7)
        self.assertEqual(payload["height"], 5)
        self.assertEqual(payload["color_type"], 6)
        self.assertEqual(payload["pixel_bytes"], 7 * 5 * 4)
        self.assertEqual(payload["sha256"],
                         hashlib.sha256(b"".join(rows)).hexdigest())

    def test_audit_rejects_corrupt_png(self):
        status, payload = self.post(b"\x89PNG\r\n\x1a\njunk")
        self.assertEqual(status, 400)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "TRUNCATED_CHUNK")

    def test_wrong_content_type(self):
        status, payload = self.post(b"whatever", content_type="text/plain")
        self.assertEqual(status, 415)
        self.assertEqual(payload["error"]["code"], "UNSUPPORTED_MEDIA_TYPE")

    def test_oversized_body(self):
        body = b"\x00" * (MAX_BODY_BYTES + 1)
        status, payload = self.post(body)
        self.assertEqual(status, 413)
        self.assertEqual(payload["error"]["code"], "PAYLOAD_TOO_LARGE")

    def test_unknown_path(self):
        status, payload = self.post(b"x", path="/nope")
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"]["code"], "NOT_FOUND")

    def test_get_on_audit_is_method_not_allowed(self):
        status, payload = self.get("/api/png/audit")
        self.assertEqual(status, 405)
        self.assertEqual(payload["error"]["code"], "METHOD_NOT_ALLOWED")

    def test_keep_alive_connection_reuse(self):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        rows = random_rows(3, 3, 0, seed=31)
        png = build_png(3, 3, 0, rows, [0, 0, 0])
        conn.request("POST", "/api/png/audit", body=png,
                     headers={"Content-Type": "image/png"})
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        response.read()
        conn.request("GET", "/health")
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        response.read()
        conn.close()

    def test_keep_alive_after_oversized_reject(self):
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        conn.request("POST", "/api/png/audit",
                     body=b"\x00" * (MAX_BODY_BYTES + 1),
                     headers={"Content-Type": "image/png"})
        response = conn.getresponse()
        self.assertEqual(response.status, 413)
        response.read()
        # The drained body must leave the connection usable.
        conn.request("GET", "/health")
        response = conn.getresponse()
        self.assertEqual(response.status, 200)
        response.read()
        conn.close()


if __name__ == "__main__":
    unittest.main()
