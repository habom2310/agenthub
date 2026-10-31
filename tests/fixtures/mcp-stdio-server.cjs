// Tiny stdio MCP server for tests. Usage: node mcp-stdio-server.cjs [ok|exit|hang|error] [toolCount]
const mode = process.argv[2] || 'ok';
const toolCount = Number(process.argv[3] || 2);
if (process.env.PIDFILE) require('node:fs').writeFileSync(process.env.PIDFILE, String(process.pid));

if (mode === 'exit') {
  console.error('fatal: missing API_KEY');
  console.error('boom: cannot start');
  process.exit(3);
}
if (mode === 'hang') {
  setInterval(() => {}, 1000);
  return;
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      console.log('starting up (stdout noise that is not JSON)');
      if (mode === 'error') return send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'init refused' } });
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } },
      });
    } else if (msg.method === 'tools/list') {
      const tools = Array.from({ length: toolCount }, (_, n) => ({ name: `tool${n}`, inputSchema: { type: 'object' } }));
      send({ jsonrpc: '2.0', id: msg.id, result: { tools } });
    }
  }
});
process.stdin.on('end', () => process.exit(0));
