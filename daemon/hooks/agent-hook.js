// Aioc hook relay: claude/codex run this as a hook; it reads the hook JSON from stdin and
// reports it to the Aioc daemon. Always exits 0 and never blocks the agent.
const http = require('http');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { if (raw.length < 512 * 1024) raw += c; });
process.stdin.on('end', () => {
  const port = process.env.AIOC_PORT;
  const session = process.env.AIOC_SESSION;
  if (!port || !session) process.exit(0);
  let payload = {};
  try { payload = JSON.parse(raw); } catch { /* keep empty */ }
  const body = JSON.stringify({ session, agent: process.argv[2] || 'unknown', payload });
  const req = http.request(
    {
      host: '127.0.0.1', port: Number(port), path: '/event', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 3000,
    },
    res => { res.resume(); res.on('end', () => process.exit(0)); }
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.end(body);
});
setTimeout(() => process.exit(0), 5000).unref();
