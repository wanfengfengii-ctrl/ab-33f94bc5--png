# PNG Audit Service

Strict PNG auditing API for the microscopy imaging pipeline. Before an
instrument-exported PNG is archived, the service proves that the file's
structure maps to exactly one decoded pixel matrix, so a lenient viewer
can never mask corruption or ambiguity.

The implementation uses only the Python standard library — no third-party
dependencies.

## API

### `POST /api/png/audit`

- Request body: `image/png`, at most 8 MiB.
- Accepted images: 8-bit, non-interlaced **grayscale** (color type 0) or
  **RGBA** (color type 6); width and height each within 1..4096.
- Structural policy: valid signature, chunk order (IHDR first, PLTE before
  IDAT, IDAT consecutive, IEND last), chunk lengths and CRC32 all valid;
  IDAT must inflate to exactly `height * (1 + width * channels)` bytes
  (every scanline including its filter byte); all five standard row
  filters (None/Sub/Up/Average/Paeth) are reversed; unknown critical
  chunks, trailing bytes after IEND, decompression overflow and truncated
  scanlines are rejected.

Success (`200`):

```json
{
  "ok": true,
  "width": 17,
  "height": 12,
  "color_type": 0,
  "color_type_name": "grayscale",
  "pixel_bytes": 204,
  "sha256": "<lowercase hex of the per-row reconstructed channel bytes>"
}
```

Failure (`400`, or `411`/`413`/`415` for transport-level problems) carries
a stable error code plus the first failing chunk (name, index, offset) or
scanline row:

```json
{
  "ok": false,
  "error": {
    "code": "BAD_FILTER_TYPE",
    "message": "scanline 3 uses unknown filter type 5",
    "row": 3
  }
}
```

Error codes: `BAD_SIGNATURE`, `TRUNCATED_CHUNK`, `BAD_CHUNK_TYPE`,
`BAD_CHUNK_LENGTH`, `BAD_CRC`, `MISSING_IHDR`, `DUPLICATE_CHUNK`,
`DIMENSION_OUT_OF_RANGE`, `UNSUPPORTED_BIT_DEPTH`,
`UNSUPPORTED_COLOR_TYPE`, `UNSUPPORTED_COMPRESSION`,
`UNSUPPORTED_FILTER_METHOD`, `UNSUPPORTED_INTERLACE`, `BAD_CHUNK_ORDER`,
`UNKNOWN_CRITICAL_CHUNK`, `NON_CONSECUTIVE_IDAT`, `MISSING_IDAT`,
`MISSING_IEND`, `TRAILING_BYTES`, `ZLIB_ERROR`, `DECOMPRESS_OVERFLOW`,
`SCANLINE_TRUNCATED`, `IDAT_TRAILING_DATA`, `BAD_FILTER_TYPE`,
`UNSUPPORTED_MEDIA_TYPE` (415), `LENGTH_REQUIRED` (411),
`PAYLOAD_TOO_LARGE` (413), `METHOD_NOT_ALLOWED` (405), `NOT_FOUND` (404).

### `GET /health`

Liveness probe returning `{"status": "ok"}`; used by the Docker
healthcheck and Compose dependency ordering.

## Run with Docker Compose

```sh
docker compose up --build api        # serve on host port 8000
PNG_AUDIT_PORT=9000 docker compose up --build api   # configurable host port
```

The container listens on port 8000 internally (`PORT` env); the host-side
port is set via `PNG_AUDIT_PORT` (default 8000).

## One-shot verification

The `verify` service waits for `api` to become healthy, then byte-compiles
the sources (build check), runs the unit test suite, and performs HTTP
smoke tests with valid and deliberately corrupted PNGs. Its exit code
reports the result:

```sh
docker compose up --build --exit-code-from verify verify
# or against an already-running API:
docker compose run --rm verify
```

Exit code `0` means every check passed; `1` means at least one failed.

## Local development (no Docker)

```sh
python3 -m unittest discover -s tests -v   # tests
PORT=8000 python3 -m app.server            # serve
API_URL=http://127.0.0.1:8000 python3 scripts/verify.py
```

## Layout

```
app/pngaudit.py    strict PNG parser, inflater, unfilter, SHA-256
app/server.py      stdlib HTTP API (POST /api/png/audit, GET /health)
tests/             unit tests + shared PNG sample builders
scripts/verify.py  one-shot verify service (build, tests, HTTP smoke)
Dockerfile, docker-compose.yml
```
