// Container health check: GET /healthz using only Node built-ins.
// Exits 0 when the API answers 200, non-zero otherwise.
import http from 'node:http';

const port = process.env.PORT || '8080';
const host = process.env.HEALTH_HOST || '127.0.0.1';

const req = http.get({ host, port, path: '/healthz', timeout: 3000 }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('error', () => process.exit(1));
req.on('timeout', () => {
  req.destroy();
  process.exit(1);
});
