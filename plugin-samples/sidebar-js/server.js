// 单次调用进程示例:宿主写入一行 JSON,这里在 stdout 打一行 JSON 后退出。
// 只读 stdin,不监听网络,不依赖第三方包。
let buffer = "";

function reply(value) {
  process.stdout.write(JSON.stringify(value) + "\n", () => process.exit(0));
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const newline = buffer.indexOf("\n");
  if (newline < 0) return;
  const line = buffer.slice(0, newline).trim();
  buffer = buffer.slice(newline + 1);
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    reply({ error: "invalid json: " + String(error) });
    return;
  }
  if (request.method === "demo.echo") {
    reply({ result: { ok: true, method: request.method, params: request.params || null, plugin: process.env.MC_PLUGIN_ID || "" } });
  } else if (request.method === "demo.env") {
    reply({ result: { cwd: process.cwd(), node: process.version, pluginDir: process.env.MC_PLUGIN_DIR || "" } });
  } else {
    reply({ error: "unknown method: " + String(request.method) });
  }
});
process.stdin.on("end", () => {
  if (buffer.trim()) reply({ error: "no newline-terminated request" });
});
