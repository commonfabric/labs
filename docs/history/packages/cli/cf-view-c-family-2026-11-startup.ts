/**
 * Prints, as one JSON line, the elapsed and processor milliseconds a fresh
 * process spends from its first statement to loading one `cf view` language
 * and coloring an empty source, the work the coverage plan's initialization
 * maximum covers. Comparing the C-family languages with the languages whose
 * initialization earlier reports recorded calibrates a run on a loaded
 * machine.
 *
 * Run it from `runtime/cli`, naming a language, once per sample:
 *
 *   for i in 1 2 3 4 5 6 7 8 9 10; do
 *     for l in toml python hcl kotlin swift c cpp; do
 *       deno run --allow-read --allow-env \
 *         ../../docs/history/packages/cli/cf-view-c-family-2026-11-startup.ts $l
 *     done
 *   done
 */

import process from "node:process";

const cpuStarted = process.cpuUsage();
const started = performance.now();

const MODULES: Readonly<Record<string, readonly [string, string]>> = {
  toml: ["toml", "tomlLanguage"],
  python: ["python", "pythonLanguage"],
  hcl: ["hcl", "hclLanguage"],
  kotlin: ["kotlin", "kotlinLanguage"],
  swift: ["swift", "swiftLanguage"],
  c: ["c-family", "cLanguage"],
  cpp: ["c-family", "cppLanguage"],
};

const [directory, exported] = MODULES[Deno.args[0]] ?? [];
if (directory === undefined) {
  throw new Error(`Name one of: ${Object.keys(MODULES).join(", ")}`);
}
const module = await import(
  `../../../../runtime/cli/lib/view/languages/${directory}/language.ts`
);
const language = module[exported];
await language.prepare();
language.highlightLines("");
const { user, system } = process.cpuUsage(cpuStarted);
console.log(JSON.stringify({
  language: Deno.args[0],
  milliseconds: performance.now() - started,
  cpuMilliseconds: (user + system) / 1000,
}));
