// Prints, one per line, the Node options that reproduce what a member's
// `deno-test` task passes to `deno test` and that matter under Node:
// each `--preload=<module>` becomes `--import=<module>`. Run from the
// member's directory, as `deno task` runs it.
//
// Usage: node nodejs/tools/member-test-options.mjs <member-dir>

import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { readDenoConfig } from "../lib/workspace.mjs";

const memberDir = path.resolve(process.argv[2] ?? ".");
const member = readDenoConfig(memberDir);
const task = member?.config.tasks?.["deno-test"];
const command = typeof task === "string" ? task : task?.command ?? "";

for (const match of command.matchAll(/--preload[= ](\S+)/g)) {
  const module = path.resolve(memberDir, match[1]);
  console.log(`--import=${pathToFileURL(module).href}`);
}
