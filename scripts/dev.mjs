import { spawn } from "node:child_process";
const children = [];
const wrangler = "node_modules/wrangler/bin/wrangler.js";
function run(args) {
  const child = spawn(process.execPath, [wrangler, ...args], {
    stdio: "inherit",
  });
  children.push(child);
  return child;
}
const migration = run([
  "d1",
  "migrations",
  "apply",
  "DB",
  "--local",
  "--config",
  "wrangler.local.jsonc",
]);
migration.on("exit", (code) => {
  if (code) return process.exit(code);
  run(["dev", "--config", "wrangler.local.jsonc"]);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    for (const child of children) child.kill("SIGTERM");
    process.exit();
  });
