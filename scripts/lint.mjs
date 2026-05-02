import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ignoredDirs = new Set([".git", ".claude", ".github", "node_modules"]);
const roots = ["."];
const files = [];

function collectJsFiles(dir) {
  for (const entry of readdirSync(dir)) {
    if (ignoredDirs.has(entry)) continue;

    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      collectJsFiles(path);
      continue;
    }

    if (entry.endsWith(".js") || entry.endsWith(".mjs")) {
      files.push(path);
    }
  }
}

for (const root of roots) {
  collectJsFiles(root);
}

let failed = false;
for (const file of files.sort()) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit"
  });

  if (result.status !== 0) {
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
}
