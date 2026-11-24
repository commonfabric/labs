/**
 * Measures the shipped `cf view` C and C++ paths against the operating maximums
 * recorded in the `cf view` language coverage plan. It drives the real language
 * objects, so what it times is what the pager runs.
 *
 * Run it from `runtime/cli`, which is where the parser packages are declared,
 * naming the language to measure:
 *
 *   deno run --allow-read --allow-env --allow-run \
 *     ../../docs/history/packages/cli/cf-view-c-family-2026-11-probe.ts cpp
 *
 * The source size, the same-length middle edit, and the sample counts follow
 * the September 2026 Python, Swift, Kotlin, TOML, and shell measurements, so
 * the runs compare directly. CUDA and headers use the C++ language's grammar
 * and query, so `cpp` measures them too. Naming `toml` measures the TOML
 * control run that calibrates a round against the TOML figures already
 * recorded.
 *
 * Each sample records the processor time the process spent beside the elapsed
 * time, so that a run on a machine whose other work delays this one can still
 * be compared with a control run of the same work.
 */

import process from "node:process";

const moduleStarted = performance.now();
const moduleStartedCpu = cpuMilliseconds();
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
  c: {
    module: "c-family/language.ts",
    exported: "cLanguage",
    prefix: "/* café appears before measured tokens */\n",
    // Each function has its own name, since a file defines a function once.
    unit: (index) => `static int render_item_${index}(struct sysmsg *msg, long n) {
  if (msg->state == STATE_READY && n > 0x10) return copy(&msg->ctx, n);
  for (int i = 0; i < n; i++) msg->buf[i] = (char)(i * 2.5);
  return sizeof(*msg) ? -EINVAL : 0;  // fall back
}
`,
    original: "render_item",
    replacement: "render_unit",
    filler: "//",
  },
  cpp: {
    module: "c-family/language.ts",
    exported: "cppLanguage",
    prefix: "// café appears before measured tokens\n",
    // Each class has its own name, since a namespace defines a class once.
    unit: (index) => `class RenderItem${index} : public Base {
 public:
  PosixErrorOr<int> Run(const std::string& path, int n) override {
    for (auto& [k, v] : items_) if (v > n) return static_cast<int>(k * 2.5);
    return PosixError(EINVAL, absl::StrCat("bad ", path));  // fall back
  }
};
`,
    original: "RenderItem",
    replacement: "RenderUnit",
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
  await language.prepare!();
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

/** The processor time this process has used, in milliseconds. */
function cpuMilliseconds(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

/** Runs `work`, returning its elapsed and processor milliseconds. */
function timed(work: () => void): { wall: number; cpu: number } {
  const cpu = cpuMilliseconds();
  const wall = performance.now();
  work();
  return { wall: performance.now() - wall, cpu: cpuMilliseconds() - cpu };
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

/** The samples, and the median and 95th percentile of each measure. */
function summary(samples: readonly { wall: number; cpu: number }[]) {
  const walls = samples.map((sample) => sample.wall);
  const cpus = samples.map((sample) => sample.cpu);
  return {
    samples,
    median: median(walls),
    p95: p95(walls),
    cpuMedian: median(cpus),
    cpuP95: p95(cpus),
  };
}

function reconstruct(lines: readonly { spans: readonly { text: string }[] }[]) {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

if (Deno.args.includes("--cold")) {
  await initialize();
  console.log(JSON.stringify({
    milliseconds: performance.now() - moduleStarted,
    cpuMilliseconds: cpuMilliseconds() - moduleStartedCpu,
  }));
  Deno.exit();
}

const language = await initialize();
const source = measuredSource();
const edit = middleEdit(source);
if (reconstruct(language.highlightLines(source)) !== source) {
  throw new Error("Highlighting changed source");
}

const highlightSamples: { wall: number; cpu: number }[] = [];
language.highlightLines(source);
for (let index = 0; index < WORK_SAMPLES; index++) {
  highlightSamples.push(timed(() => language.highlightLines(source)));
}

const documentSamples: { wall: number; cpu: number }[] = [];
language.parseDocument(source);
for (let index = 0; index < WORK_SAMPLES; index++) {
  documentSamples.push(timed(() => language.parseDocument(source)));
}

const incrementalSamples: { wall: number; cpu: number }[] = [];
for (let index = 0; index < WORK_SAMPLES + 1; index++) {
  const highlighter = language.createHighlighter(source);
  let updated: readonly { spans: readonly { text: string }[] }[] = [];
  const sample = timed(() => updated = highlighter.update(edit.source));
  if (reconstruct(updated) !== edit.source) {
    throw new Error("An incremental update changed source");
  }
  if (index > 0) incrementalSamples.push(sample);
}

const startupSamples: { wall: number; cpu: number }[] = [];
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
  startupSamples.push({ wall: cold.milliseconds, cpu: cold.cpuMilliseconds });
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
    startupMilliseconds: summary(startupSamples),
    fullHighlightMilliseconds: summary(highlightSamples),
    parseDocumentMilliseconds: summary(documentSamples),
    incrementalEditMilliseconds: summary(incrementalSamples),
  },
  null,
  2,
));
