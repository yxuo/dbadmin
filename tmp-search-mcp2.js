const fs = require("fs");
const s = fs.readFileSync(
  "C:/Users/rapha/AppData/Local/Programs/cursor/resources/app/out/vs/workbench/workbench.desktop.main.js",
  "utf8",
);
const keys = [
  "mcp.reload",
  "mcp.rebuildServers",
  "mcp.resetCachedTools",
  "reloadMcp",
  "initializeUserConfiguredServers",
  "workbench.mcp",
  "mcp.openUserConfiguration",
];
for (const k of keys) {
  const i = s.indexOf(k);
  console.log(k, i);
  if (i >= 0) console.log(s.slice(Math.max(0, i - 60), i + 140));
}
