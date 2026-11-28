/**
 * Measures the Lezer HTML parser that the UI package's editor already pins,
 * through `@codemirror/lang-html`, on the source and edit of the adjacent
 * HTML probe, for comparison with the shipped Tree-sitter path. Lezer's HTML
 * grammar parses `script` and `style` elements and `style` and event handler
 * attributes with its JavaScript and CSS grammars. Each sample parses the
 * source and gives every character the class of the narrowest highlight tag
 * over it, which is the work the adapter's complete highlight does. Each
 * sample records the processor time the process used beside the time that
 * elapsed, as the HTML probe's do.
 *
 * Run it from `runtime/cli`, without the lockfile, since the CLI does not
 * declare these packages:
 *
 *   deno run --no-lock --allow-read --allow-env --allow-run \
 *     ../../docs/history/packages/cli/cf-view-html-2026-11-lezer.ts
 *
 * With `--corpus`, it instead reads file names one per line on standard input
 * and reports the files and lines that hold a node Lezer's error recovery
 * inserted.
 */

import process from "node:process";

const moduleStarted = performance.now();
const moduleCpuStarted = cpuNow();

/** Milliseconds of processor time this process has used, in every thread. */
function cpuNow(): number {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000;
}
const STARTUP_SAMPLES = 40;
const WORK_SAMPLES = 50;
const TARGET_BYTES = 100_009;

async function initialize() {
  const { parser } = await import("npm:@lezer/html@1.3.13");
  const { classHighlighter, highlightTree } = await import(
    "npm:@lezer/highlight@1.2.3"
  );
  const { TreeFragment } = await import("npm:@lezer/common@1.5.2");
  type Tree = ReturnType<typeof parser.parse>;
  const classify = (text: string, tree: Tree) => {
    const classes = new Array<string | undefined>(text.length);
    highlightTree(tree, classHighlighter, (from, to, cls) => {
      classes.fill(cls, from, to);
    });
    return classes;
  };
  classify("", parser.parse(""));
  return { parser, classify, TreeFragment };
}

if (Deno.args.includes("--cold")) {
  await initialize();
  console.log(JSON.stringify({
    milliseconds: performance.now() - moduleStarted,
    cpuMilliseconds: cpuNow() - moduleCpuStarted,
  }));
  Deno.exit();
}

const { parser, classify, TreeFragment } = await initialize();

if (Deno.args.includes("--corpus")) {
  const paths = (await new Response(Deno.stdin.readable).text()).split("\n")
    .filter((path) => path !== "");
  const withErrors: { path: string; errorLines: number }[] = [];
  let lines = 0;
  for (const path of paths) {
    const source = await Deno.readTextFile(path);
    const starts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source[i] === "\n") starts.push(i + 1);
    }
    lines += starts.length;
    const rowOf = (offset: number) => {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (starts[middle] <= offset) low = middle;
        else high = middle - 1;
      }
      return low;
    };
    const rows = new Set<number>();
    parser.parse(source).iterate({
      enter(node) {
        if (!node.type.isError) return;
        for (let row = rowOf(node.from); row <= rowOf(node.to); row++) {
          rows.add(row);
        }
      },
    });
    if (rows.size > 0) withErrors.push({ path, errorLines: rows.size });
  }
  console.log(JSON.stringify(
    {
      files: paths.length,
      lines,
      withErrors,
      errorLines: withErrors.reduce((sum, file) => sum + file.errorLines, 0),
    },
    null,
    2,
  ));
  Deno.exit();
}

/** The adjacent HTML probe's repeated unit. */
const unit = (index: number) =>
  `<section id="item-${index}" class="card">
  <h2 title="Render &amp; item">Render item ${index}</h2>
  <p style="color: red; margin: 0">See <a href="/i/${index}" onclick="track(${index})">it</a>.</p>
  <script>renderItem(${index}, { size: 2.5, tags: ["a", "b"] });</script>
  <style>.card-${index} { padding: calc(var(--s) * 2); }</style>
</section>
`;

function measuredSource(): string {
  const encoder = new TextEncoder();
  let source = "<!-- café appears before measured tokens -->\n";
  for (let index = 0;; index++) {
    if (encoder.encode(source + unit(index)).length + 3 > TARGET_BYTES) break;
    source += unit(index);
  }
  const remaining = TARGET_BYTES - encoder.encode(source).length;
  if (remaining > 0) source += "<!--" + "x".repeat(remaining - 4);
  if (encoder.encode(source).length !== TARGET_BYTES) {
    throw new Error("The measured source has the wrong byte length");
  }
  return source;
}

function median(samples: readonly number[]): number {
  const sorted = samples.toSorted((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[Math.floor(middle)];
}

function p95(samples: readonly number[]): number {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

const source = measuredSource();
const editAt = source.indexOf("renderItem", Math.floor(source.length / 2));
const edited = source.slice(0, editAt) + "renderUnit" +
  source.slice(editAt + "renderItem".length);

/** Elapsed and processor milliseconds of each sample of one operation. */
class Samples {
  readonly wall: number[] = [];
  readonly cpu: number[] = [];

  /** Time `operation`. */
  take(operation: () => unknown): void {
    const wallStarted = performance.now();
    const cpuStarted = cpuNow();
    operation();
    this.cpu.push(cpuNow() - cpuStarted);
    this.wall.push(performance.now() - wallStarted);
  }

  summary() {
    return {
      samples: this.wall,
      median: median(this.wall),
      p95: p95(this.wall),
      cpuSamples: this.cpu,
      cpuMedian: median(this.cpu),
      cpuP95: p95(this.cpu),
    };
  }
}

const highlightSamples = new Samples();
classify(source, parser.parse(source));
for (let index = 0; index < WORK_SAMPLES; index++) {
  highlightSamples.take(() => classify(source, parser.parse(source)));
}

const incrementalSamples = new Samples();
for (let index = 0; index < WORK_SAMPLES + 1; index++) {
  const tree = parser.parse(source);
  const fragments = TreeFragment.applyChanges(
    TreeFragment.addTree(tree),
    [{ fromA: editAt, toA: editAt + 10, fromB: editAt, toB: editAt + 10 }],
  );
  const samples = index > 0 ? incrementalSamples : new Samples();
  samples.take(() => classify(edited, parser.parse(edited, fragments)));
}

const startupSamples = new Samples();
for (let index = 0; index < STARTUP_SAMPLES; index++) {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-lock",
      "--allow-read",
      "--allow-env",
      import.meta.filename!,
      "--cold",
    ],
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!output.success) throw new Error("Cold-start child failed");
  const cold = JSON.parse(new TextDecoder().decode(output.stdout));
  startupSamples.wall.push(cold.milliseconds);
  startupSamples.cpu.push(cold.cpuMilliseconds);
}

console.log(JSON.stringify(
  {
    language: "lezer-html",
    fixtureBytes: new TextEncoder().encode(source).length,
    startupMilliseconds: startupSamples.summary(),
    fullHighlightMilliseconds: highlightSamples.summary(),
    incrementalEditMilliseconds: incrementalSamples.summary(),
  },
  null,
  2,
));
