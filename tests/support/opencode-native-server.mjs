import { renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const args = process.argv.slice(2);
const hostname = args[args.indexOf("--hostname") + 1];
const port = Number(args[args.indexOf("--port") + 1]);
const authorization = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`;
const server = createServer((request, response) => {
  if (request.headers.authorization !== authorization) return response.writeHead(401).end();
  if (request.url === "/api/info") {
    if (process.env.OPEN_CODE_FIXTURE_STALL === "readiness") return;
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(
      JSON.stringify({ version: "2.0.20", pid: process.pid, urls: [], paths: { tmp: process.cwd() } }),
    );
  }
  if (request.url === "/api/event") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    return response.write('data: {"type":"server.connected","data":{}}\r\n\r\n');
  }
  response.writeHead(404).end();
});
server.listen(port, hostname, () => {
  writeFileSync("opencode-child.tmp", JSON.stringify({ pid: process.pid, env: process.env }));
  renameSync("opencode-child.tmp", "opencode-child.json");
});
