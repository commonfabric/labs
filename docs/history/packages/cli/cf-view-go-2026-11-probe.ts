/**
 * Measures the shipped `cf view` Go, Go module file, and Go checksum file paths
 * against the operating maximums recorded in the `cf view` language coverage
 * plan. It drives the real language objects, so what it times is what the
 * pager runs.
 *
 * Run it from `runtime/cli`, which is where the parser packages are declared,
 * naming the language to measure:
 *
 *   deno run --allow-read --allow-env --allow-run \
 *     ../../docs/history/packages/cli/cf-view-go-2026-11-probe.ts go
 *
 * The source size, the same-length middle edit, and the sample counts follow
 * the earlier Python, Swift, Kotlin, TOML, shell, and HCL measurements, so the
 * runs compare directly. Naming `toml` measures the TOML control run that
 * calibrates a round against the TOML figures already recorded, and naming
 * `go-mod` or `go-sum` measures the focused scanners for the two manifests.
 *
 * Each sample records both the wall-clock time and the processor time the
 * process spent, summed over its threads. On a machine whose processors are
 * all busy, the wall-clock time includes the time the process waited for a
 * processor, and the processor time does not.
 */

import process from "node:process";

const moduleStarted = performance.now();
const moduleStartedCpu = process.cpuUsage();
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

const SUBJECTS: Readonly<Record<string, Subject>> = {
  go: {
    module: "go/language.ts",
    exported: "goLanguage",
    prefix: "// café appears before measured tokens\npackage render\n\n",
    // Each function has its own name, since a package declares a function
    // only once.
    unit: (index) => `func renderItem${index}(items []Item, limit int) (string, error) {
\tvar out strings.Builder
\tfor i, item := range items {
\t\tif i >= limit {
\t\t\tbreak
\t\t}
\t\tfmt.Fprintf(&out, "%s: %d\\n", item.Name, item.Count*2)
\t}
\treturn out.String(), nil
}
`,
    original: "renderItem",
    replacement: "renderUnit",
    filler: "//",
  },
  "go-mod": {
    module: "go/language.ts",
    exported: "goModLanguage",
    prefix: "// café appears before measured tokens\nmodule gvisor.dev/gvisor\n\ngo 1.26.10\n\nrequire (\n",
    unit: (index) =>
      `\tgithub.com/render/item${index} v1.4.1-0.20240526193622-a339e1f7089c // indirect\n`,
    original: "render/item",
    replacement: "render/unit",
    filler: "//",
  },
  "go-sum": {
    module: "go/language.ts",
    exported: "goSumLanguage",
    prefix: "",
    unit: (index) =>
      `github.com/render/item${index} v1.4.1/go.mod h1:aQUYkXzVsufM+DwF1aE+0xfcU+56JwCaLick0ClmMTw=\n`,
    original: "render/item",
    replacement: "render/unit",
    filler: "x",
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

/** Milliseconds of processor time the process has spent since `since`. */
function cpuSince(since: { user: number; system: number }): number {
  const { user, system } = process.cpuUsage(since);
  return (user + system) / 1000;
}

/** Wall-clock and processor-time samples of one operation. */
class Samples {
  readonly wall: number[] = [];
  readonly cpu: number[] = [];

  time<T>(operation: () => T): T {
    const cpuStarted = process.cpuUsage();
    const started = performance.now();
    const result = operation();
    this.wall.push(performance.now() - started);
    this.cpu.push(cpuSince(cpuStarted));
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

if (Deno.args.includes("--cold")) {
  await initialize();
  console.log(JSON.stringify({
    milliseconds: performance.now() - moduleStarted,
    cpuMilliseconds: cpuSince(moduleStartedCpu),
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
  highlightSamples.time(() => language.highlightLines(source));
}

const documentSamples = new Samples();
language.parseDocument(source);
for (let index = 0; index < WORK_SAMPLES; index++) {
  documentSamples.time(() => language.parseDocument(source));
}

const incrementalSamples = new Samples();
for (let index = 0; index < WORK_SAMPLES + 1; index++) {
  const highlighter = language.createHighlighter(source);
  // The first update warms the path, and is not kept.
  const samples = index > 0 ? incrementalSamples : new Samples();
  const updated = samples.time(() => highlighter.update(edit.source));
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
  const child = JSON.parse(new TextDecoder().decode(output.stdout));
  startupSamples.wall.push(child.milliseconds);
  startupSamples.cpu.push(child.cpuMilliseconds);
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
