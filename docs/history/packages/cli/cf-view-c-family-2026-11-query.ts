/**
 * Prints, as JSON, the processor milliseconds each shipped Tree-sitter
 * language of `cf view` spends compiling its highlight query: the minimum of
 * five compilations in one process, so that the query costs of the grammars
 * compare under the same load.
 *
 * Run it from `runtime/cli`:
 *
 *   deno run --allow-read --allow-env \
 *     ../../docs/history/packages/cli/cf-view-c-family-2026-11-query.ts
 */

import process from "node:process";
import { Language, Parser, Query } from "npm:web-tree-sitter@0.26.12";
import type { TreeSitterGrammar } from "../../../../runtime/cli/lib/view/languages/treesitter/adapter.ts";
import { treeSitterGrammars } from "../../../../runtime/cli/lib/view/languages/treesitter/grammars.ts";

function cpuMilliseconds(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

async function queryMilliseconds(grammar: TreeSitterGrammar): Promise<number> {
  const language = await Language.load(
    await Deno.readFile(new URL(grammar.wasmUrl())),
  );
  let fastest = Infinity;
  for (let round = 0; round < 5; round++) {
    const started = cpuMilliseconds();
    new Query(language, grammar.highlightQuery).delete();
    fastest = Math.min(fastest, cpuMilliseconds() - started);
  }
  return fastest;
}

await Parser.init();
const costs: Record<string, number> = {};
for (const grammar of treeSitterGrammars) {
  costs[grammar.id] = Number((await queryMilliseconds(grammar)).toFixed(1));
}
console.log(JSON.stringify(costs));
