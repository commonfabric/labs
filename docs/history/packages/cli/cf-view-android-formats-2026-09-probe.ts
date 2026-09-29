/**
 * Measures the shipped `cf view` Kotlin and TOML paths against the operating
 * maximums recorded in the `cf view` language coverage plan. It drives the
 * real language objects, so what it times is what the pager runs.
 *
 * Run it from `packages/cli`, which is where the parser packages are declared,
 * naming the language to measure:
 *
 *   deno run --allow-read --allow-env --allow-run \
 *     ../../docs/history/packages/cli/cf-view-android-formats-2026-09-probe.ts \
 *     kotlin
 *
 * The source size, the same-length middle edit, and the sample counts follow
 * the September 2026 Python and Swift measurements, so the runs compare
 * directly.
 */

const moduleStarted = performance.now();
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
  kotlin: {
    module: "kotlin/language.ts",
    exported: "kotlinLanguage",
    prefix: "// café appears before measured tokens\n",
    unit: () => `@Suppress("unused")
internal class RenderedItem<T : Any>(private val scope: CoroutineScope) {
    suspend fun renderItem(value: T? = null): String {
        val label = "value=\${value?.toString() ?: "none"}"
        return label
    }
}
`,
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
    `../../../../packages/cli/lib/view/languages/${subject.module}`
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
  console.log(JSON.stringify({ milliseconds: performance.now() - moduleStarted }));
  Deno.exit();
}

const language = await initialize();
const source = measuredSource();
const edit = middleEdit(source);
if (reconstruct(language.highlightLines(source)) !== source) {
  throw new Error("Highlighting changed source");
}

const highlightSamples: number[] = [];
language.highlightLines(source);
for (let index = 0; index < WORK_SAMPLES; index++) {
  const started = performance.now();
  language.highlightLines(source);
  highlightSamples.push(performance.now() - started);
}

const documentSamples: number[] = [];
language.parseDocument(source);
for (let index = 0; index < WORK_SAMPLES; index++) {
  const started = performance.now();
  language.parseDocument(source);
  documentSamples.push(performance.now() - started);
}

const incrementalSamples: number[] = [];
for (let index = 0; index < WORK_SAMPLES + 1; index++) {
  const highlighter = language.createHighlighter(source);
  const started = performance.now();
  const updated = highlighter.update(edit.source);
  const milliseconds = performance.now() - started;
  if (reconstruct(updated) !== edit.source) {
    throw new Error("An incremental update changed source");
  }
  if (index > 0) incrementalSamples.push(milliseconds);
}

const startupSamples: number[] = [];
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
  startupSamples.push(
    JSON.parse(new TextDecoder().decode(output.stdout)).milliseconds,
  );
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
    startupMilliseconds: {
      samples: startupSamples,
      median: median(startupSamples),
      p95: p95(startupSamples),
    },
    fullHighlightMilliseconds: {
      samples: highlightSamples,
      median: median(highlightSamples),
      p95: p95(highlightSamples),
    },
    parseDocumentMilliseconds: {
      samples: documentSamples,
      median: median(documentSamples),
      p95: p95(documentSamples),
    },
    incrementalEditMilliseconds: {
      samples: incrementalSamples,
      median: median(incrementalSamples),
      p95: p95(incrementalSamples),
    },
  },
  null,
  2,
));
