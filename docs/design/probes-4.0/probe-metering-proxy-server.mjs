// Minimal metering proxy probe: forwards every request to api.anthropic.com,
// logs method, path, body size, max_tokens, and usage seen in the response.
import http from 'node:http';
import https from 'node:https';
import { appendFileSync } from 'node:fs';
const LOG = process.argv[2];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let maxTokens = null, model = null;
    try { const j = JSON.parse(body.toString('utf8')); maxTokens = j.max_tokens ?? null; model = j.model ?? null; } catch {}
    const headers = { ...req.headers, host: 'api.anthropic.com' };
    delete headers['content-length']; headers['content-length'] = String(body.length); headers['accept-encoding'] = 'identity';
    const up = https.request({ host: 'api.anthropic.com', port: 443, method: req.method, path: req.url, headers }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      let tail = '';
      ur.on('data', (c) => { res.write(c); tail = (tail + c.toString('utf8')).slice(-20000); });
      ur.on('end', () => {
        res.end();
        const usages = [...tail.matchAll(/"usage":\s*(\{[^}]*\})/g)].map((m) => m[1]);
        appendFileSync(LOG, JSON.stringify({ method: req.method, path: req.url, status: ur.statusCode, bodyBytes: body.length, maxTokens, model, auth: req.headers['authorization'] ? 'bearer' : (req.headers['x-api-key'] ? 'x-api-key' : 'none'), usages }) + '\n');
      });
    });
    up.on('error', (e) => { res.writeHead(502); res.end(String(e)); appendFileSync(LOG, JSON.stringify({ error: String(e) }) + '\n'); });
    up.end(body);
  });
});
server.listen(0, '127.0.0.1', () => { console.log(server.address().port); });
