/**
 * Compares the shipped `cf view` Go grammar with the same grammar less the
 * pattern that colors the comments before `import "C"` as code. It times a
 * complete highlight and a re-color after one edit of the probe's 100-kilobyte
 * Go source, alternating between the two grammars in one process, and prints
 * every sample in wall-clock and in processor time.
 *
 * Run it from `runtime/cli`, which is where the parser packages are declared:
 *
 *   deno run --allow-read --allow-env \
 *     ../../docs/history/packages/cli/cf-view-go-2026-11-preamble.ts
 */

import process from "node:process";
import { goGrammar } from "../../../../runtime/cli/lib/view/languages/go/go.ts";
import {
  createHighlighter,
  highlightLines,
  prepareGrammar,
} from "../../../../runtime/cli/lib/view/languages/treesitter/adapter.ts";

const ROUNDS = 40;
const PREAMBLE = /; The comments between[\s\S]*?\(#eq\? @string "\\"C\\""\)\)\n/;

const without = {
  ...goGrammar,
  id: "go-without-preamble",
  highlightQuery: goGrammar.highlightQuery.replace(PREAMBLE, ""),
};
if (without.highlightQuery === goGrammar.highlightQuery) {
  throw new Error("The preamble pattern was not found");
}
await prepareGrammar(goGrammar);
await prepareGrammar(without);

// The probe's Go unit, repeated to 100 kilobytes after the same prefix.
let source = "// café appears before measured tokens\npackage render\n\n";
for (let index = 0; new TextEncoder().encode(source).length < 100_000;) {
  source += `func renderItem${index++}(items []Item, limit int) (string, error) {
\tvar out strings.Builder
\tfor i, item := range items {
\t\tif i >= limit {
\t\t\tbreak
\t\t}
\t\tfmt.Fprintf(&out, "%s: %d\\n", item.Name, item.Count*2)
\t}
\treturn out.String(), nil
}
`;
}
const edited = source.replace("renderItem40(", "renderUnit40(");

interface Timing {
  readonly wall: number[];
  readonly cpu: number[];
}

function time(timing: Timing, operation: () => unknown): void {
  const cpuStarted = process.cpuUsage();
  const started = performance.now();
  operation();
  timing.wall.push(performance.now() - started);
  const { user, system } = process.cpuUsage(cpuStarted);
  timing.cpu.push((user + system) / 1000);
}

const timings: Record<string, Timing> = {};
for (const operation of ["highlight", "recolor"]) {
  for (const grammar of ["with", "without"]) {
    timings[`${operation} ${grammar}`] = { wall: [], cpu: [] };
  }
}
for (let round = 0; round < ROUNDS; round++) {
  for (const [name, grammar] of [["with", goGrammar], ["without", without]] as const) {
    time(timings[`highlight ${name}`], () => highlightLines(grammar, source));
    const highlighter = createHighlighter(grammar, source);
    time(timings[`recolor ${name}`], () => highlighter.update(edited));
  }
}

const median = (samples: readonly number[]) =>
  samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)];
console.log(JSON.stringify(
  Object.fromEntries(
    Object.entries(timings).map(([name, { wall, cpu }]) => [name, {
      wallMedian: median(wall),
      cpuMedian: median(cpu),
      wall,
      cpu,
    }]),
  ),
  null,
  2,
));
