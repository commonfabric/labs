/**
 * Measures the shipped `cf view` HTML path, with the languages that color its
 * embedded regions, against the operating maximums recorded in the `cf view`
 * language coverage plan. It drives the real language objects, so what it
 * times is what the pager runs.
 *
 * Run it from `runtime/cli`, which is where the parser packages are declared,
 * naming the language to measure:
 *
 *   deno run --allow-read --allow-env --allow-run \
 *     ../../docs/history/packages/cli/cf-view-html-2026-11-probe.ts html
 *
 * The source size, the same-length middle edit, and the sample counts follow
 * the earlier Python, Swift, Kotlin, TOML, shell, and HCL measurements, so
 * the runs compare directly. Naming `html-script` measures a page that is one
 * large script, and `script` the same script as a file of its own. Naming
 * `toml` measures the TOML control run that
 * calibrates a round against the TOML figures already recorded. Each sample
 * records the processor time the process used beside the time that elapsed,
 * since other work on a loaded machine inflates the first less.
 */

import process from "node:process";
// Every `cf view` process loads the TypeScript language at startup, through
// the language registry, and HTML colors scripts with it, so it is loaded
// before initialization is timed.
import "../../../../runtime/cli/lib/view/languages/typescript/parse.ts";

const moduleStarted = performance.now();
const moduleCpuStarted = cpuNow();
const STARTUP_SAMPLES = 40;
const WORK_SAMPLES = 50;
const TARGET_BYTES = 100_009;

interface Subject {
  readonly module: string;
  readonly exported: string;
  readonly prefix: string;
  /** The repeated source, given how many units precede it. */
  readonly unit: (index: number) => string;
  readonly original: string;
  readonly replacement: string;
  readonly filler: string;
}

/** A JavaScript function with its own name, for the script subjects. */
function scriptUnit(index: number): string {
  return `function renderItem${index}(items, options = {}) {
  const size = options.size ?? 2.5;
  return items.filter((item) => item.id !== ${index})
    .map((item) => ({ ...item, size, label: \`#\${item.id}\` }));
}
`;
}

const SUBJECTS: Readonly<Record<string, Subject>> = {
  html: {
    module: "html/language.ts",
    exported: "htmlLanguage",
    prefix: "<!-- café appears before measured tokens -->\n",
    // Each unit holds a script, an event handler, a style attribute, and a
    // style element, so the source exercises every embedded region.
    unit: (index) => `<section id="item-${index}" class="card">
  <h2 title="Render &amp; item">Render item ${index}</h2>
  <p style="color: red; margin: 0">See <a href="/i/${index}" onclick="track(${index})">it</a>.</p>
  <script>renderItem(${index}, { size: 2.5, tags: ["a", "b"] });</script>
  <style>.card-${index} { padding: calc(var(--s) * 2); }</style>
</section>
`,
    original: "renderItem",
    replacement: "renderUnit",
    filler: "<!--",
  },
  // A page that is one large script, and the same script as a file of its own.
  "html-script": {
    module: "html/language.ts",
    exported: "htmlLanguage",
    prefix: "<!doctype html>\n<script>\n// café appears before measured tokens\n",
    unit: scriptUnit,
    original: "renderItem",
    replacement: "renderUnit",
    filler: "//",
  },
  script: {
    module: "typescript/language.ts",
    exported: "typeScriptLanguage",
    prefix: "// café appears before measured tokens\n",
    unit: scriptUnit,
    original: "renderItem",
    replacement: "renderUnit",
    filler: "//",
  },
  toml: {
    module: "toml/language.ts",
    exported: "tomlLanguage",
    prefix: "# café appears before measured tokens\n",
    // Each table has its own name, since TOML defines a table only once.
    unit: (index) => `[libraries.item${index}]
group = "androidx.compose.ui"
name = "renderItem"
version = { ref = "compose", strictly = [1, 2.5, true] }
`,
    original: "renderItem",
    replacement: "renderUnit",
    filler: "#",
  },
};

const subjectName = Deno.args.find((arg) => !arg.startsWith("--"))!;
const subject = SUBJECTS[subjectName];
if (subject === undefined) {
  throw new Error(`Name one of: ${Object.keys(SUBJECTS).join(", ")}`);
}

/** Load the language and its parser, then color an empty source. */
async function initialize() {
  const module = await import(
    `../../../../runtime/cli/lib/view/languages/${subject.module}`
  );
  const language = module[subject.exported];
  await language.prepare?.();
  language.highlightLines("");
  return language;
}

function measuredSource(): string {
  const encoder = new TextEncoder();
  let source = subject.prefix;
  for (let index = 0;; index++) {
    const unit = subject.unit(index);
    if (encoder.encode(source + unit).length + 3 > TARGET_BYTES) break;
    source += unit;
  }
  const remaining = TARGET_BYTES - encoder.encode(source).length;
  if (remaining > 0) {
    source += subject.filler +
      "x".repeat(remaining - subject.filler.length);
  }
  if (encoder.encode(source).length !== TARGET_BYTES) {
    throw new Error("The measured source has the wrong byte length");
  }
  return source;
}

function middleEdit(source: string) {
  const startIndex = source.indexOf(
    subject.original,
    Math.floor(source.length / 2),
  );
  if (startIndex < 0) throw new Error("Middle edit target is absent");
  return {
    source: source.slice(0, startIndex) + subject.replacement +
      source.slice(startIndex + subject.original.length),
  };
}

/** Milliseconds of processor time this process has used, in every thread. */
function cpuNow(): number {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000;
}

/** Elapsed and processor milliseconds of each sample of one operation. */
class Samples {
  readonly wall: number[] = [];
  readonly cpu: number[] = [];

  /** Time `operation`. */
  take<T>(operation: () => T): T {
    const wallStarted = performance.now();
    const cpuStarted = cpuNow();
    const result = operation();
    this.cpu.push(cpuNow() - cpuStarted);
    this.wall.push(performance.now() - wallStarted);
    return result;
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

function reconstruct(lines: readonly { spans: readonly { text: string }[] }[]) {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

if (Deno.args.includes("--cold")) {
  await initialize();
  console.log(JSON.stringify({
    milliseconds: performance.now() - moduleStarted,
    cpuMilliseconds: cpuNow() - moduleCpuStarted,
  }));
  Deno.exit();
}

const language = await initialize();
const source = measuredSource();
const edit = middleEdit(source);
if (reconstruct(language.highlightLines(source)) !== source) {
  throw new Error("Highlighting changed source");
}

const highlightSamples = new Samples();
language.highlightLines(source);
for (let index = 0; index < WORK_SAMPLES; index++) {
  highlightSamples.take(() => language.highlightLines(source));
}

const documentSamples = new Samples();
language.parseDocument(source);
for (let index = 0; index < WORK_SAMPLES; index++) {
  documentSamples.take(() => language.parseDocument(source));
}

const incrementalSamples = new Samples();
language.createHighlighter(source).update(edit.source);
for (let index = 0; index < WORK_SAMPLES; index++) {
  const highlighter = language.createHighlighter(source);
  const updated = incrementalSamples.take(() =>
    highlighter.update(edit.source)
  );
  if (reconstruct(updated) !== edit.source) {
    throw new Error("An incremental update changed source");
  }
}

const startupSamples = new Samples();
for (let index = 0; index < STARTUP_SAMPLES; index++) {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-env",
      import.meta.filename!,
      subjectName,
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
    language: subjectName,
    environment: {
      deno: Deno.version.deno,
      v8: Deno.version.v8,
      typescript: Deno.version.typescript,
      os: Deno.build.os,
      arch: Deno.build.arch,
    },
    fixtureBytes: new TextEncoder().encode(source).length,
    startupMilliseconds: startupSamples.summary(),
    fullHighlightMilliseconds: highlightSamples.summary(),
    parseDocumentMilliseconds: documentSamples.summary(),
    incrementalEditMilliseconds: incrementalSamples.summary(),
  },
  null,
  2,
));
