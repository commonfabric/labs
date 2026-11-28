/**
 * Measures the shipped `cf view` Starlark and Bazel rc paths against the
 * operating maximums recorded in the `cf view` language coverage plan. It
 * drives the real language objects, so what it times is what the pager runs.
 * Each sample records both the elapsed time and the processor time the process
 * spent, which other work on a loaded machine inflates less.
 *
 * Run it from `runtime/cli`, which is where the parser packages are declared,
 * naming the language to measure:
 *
 *   deno run --allow-read --allow-env --allow-run \
 *     ../../docs/history/packages/cli/cf-view-starlark-2026-11-probe.ts starlark
 *
 * The source size, the same-length middle edit, and the sample counts follow
 * the earlier Python, Swift, Kotlin, TOML, shell, and HCL measurements, so the
 * runs compare directly. Naming `toml` measures the TOML control run that
 * calibrates a round against the TOML figures already recorded.
 */

import process from "node:process";

const moduleStarted = performance.now();
const moduleCpuStarted = process.cpuUsage();
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
  starlark: {
    module: "starlark/language.ts",
    exported: "starlarkLanguage",
    prefix: "# café appears before measured tokens\n",
    // Each target has its own name, since a package declares a target only
    // once.
    unit: (index) => `go_library(
    name = "render_item_${index}",
    srcs = glob(["*.go"], exclude = ["*_test.go"]) + ["gen_%d.go" % 3],
    deps = select({":race": ["//pkg/race"], "//conditions:default": []}),
    stateify = True,
    visibility = ["//:sandbox"],
)
`,
    original: "render_item",
    replacement: "render_unit",
    filler: "#",
  },
  bazelrc: {
    module: "bazelrc/language.ts",
    exported: "bazelrcLanguage",
    prefix: "# café appears before measured tokens\n",
    unit: (index) =>
      `build:render_item_${index} --@io_bazel_rules_go//go/config:race --copt="-O2 -g" --cpu k8 # note
`,
    original: "render_item",
    replacement: "render_unit",
    filler: "#",
  },
  // Options with no values, which once made the scanner look for an `=`
  // to the end of the file from each option.
  "bazelrc-bare": {
    module: "bazelrc/language.ts",
    exported: "bazelrcLanguage",
    prefix: "# café appears before measured tokens\n",
    unit: (index) =>
      `build --stamp --nocache_test_results --render_item_${index} --keep_going
`,
    original: "render_item",
    replacement: "render_unit",
    filler: "#",
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

/** The processor time, user and system, spent since `since`. */
function cpuMilliseconds(since: ReturnType<typeof process.cpuUsage>): number {
  const spent = process.cpuUsage(since);
  return (spent.user + spent.system) / 1000;
}

/** Elapsed and processor time samples of one operation. */
class Samples {
  readonly wall: number[] = [];
  readonly cpu: number[] = [];

  /** Time `operation`, keeping the sample unless `keep` is false. */
  time<T>(operation: () => T, keep = true): T {
    const started = performance.now();
    const cpuStarted = process.cpuUsage();
    const result = operation();
    const wall = performance.now() - started;
    const cpu = cpuMilliseconds(cpuStarted);
    if (keep) {
      this.wall.push(wall);
      this.cpu.push(cpu);
    }
    return result;
  }

  toJSON() {
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
    cpuMilliseconds: cpuMilliseconds(moduleCpuStarted),
  }));
  Deno.exit();
}

const language = await initialize();
const source = measuredSource();
const edit = middleEdit(source);
if (reconstruct(language.highlightLines(source)) !== source) {
  throw new Error("Highlighting changed source");
}

const highlight = new Samples();
language.highlightLines(source);
for (let index = 0; index < WORK_SAMPLES; index++) {
  highlight.time(() => language.highlightLines(source));
}

const document = new Samples();
language.parseDocument(source);
for (let index = 0; index < WORK_SAMPLES; index++) {
  document.time(() => language.parseDocument(source));
}

const incremental = new Samples();
for (let index = 0; index < WORK_SAMPLES + 1; index++) {
  const highlighter = language.createHighlighter(source);
  const updated = incremental.time(
    () => highlighter.update(edit.source),
    index > 0,
  );
  if (reconstruct(updated) !== edit.source) {
    throw new Error("An incremental update changed source");
  }
}

const startup = new Samples();
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
  startup.wall.push(child.milliseconds);
  startup.cpu.push(child.cpuMilliseconds);
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
    startupMilliseconds: startup,
    fullHighlightMilliseconds: highlight,
    parseDocumentMilliseconds: document,
    incrementalEditMilliseconds: incremental,
  },
  null,
  2,
));
