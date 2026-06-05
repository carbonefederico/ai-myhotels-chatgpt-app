import { spawn } from "node:child_process";

const children = [
  {
    name: "api-server",
    child: spawn("node", ["dist/api-server/server.js"], { stdio: "inherit" }),
  },
  {
    name: "mcp-server",
    child: spawn("node", ["dist/mcp-server/server.js"], { stdio: "inherit" }),
  },
];

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  for (const { child } of children) {
    child.kill(signal);
  }
}

for (const { name, child } of children) {
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[start-local] ${name} exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      shutdown("SIGTERM");
      process.exit(code ?? 1);
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
