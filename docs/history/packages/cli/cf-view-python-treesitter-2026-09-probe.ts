/**
 * Measures the shipped `cf view` Python path against the operating maximums
 * recorded in the `cf view` language coverage plan. It drives the real
 * language object, so what it times is what the pager runs.
 *
 * Run it from `packages/cli`, which is where the parser packages are declared:
 *
 *   deno run --allow-read --allow-env --allow-run \
 *     ../../docs/history/packages/cli/cf-view-python-treesitter-2026-09-probe.ts
 *
 * The source, the same-length middle edit, and the sample counts follow the
 * August 2026 operating-envelope probe, so the two runs compare directly.
 */

const moduleStarted = performance.now();
const STARTUP_SAMPLES = 40;
const WORK_SAMPLES = 50;
const TARGET_BYTES = 100_009;

const languageModule =
  "../../../../packages/cli/lib/view/languages/python/language.ts";

/** Load the language and its parser, then color an empty source. */
async function initializePython() {
  const { pythonLanguage } = await import(languageModule);
  await pythonLanguage.prepare!();
  pythonLanguage.highlightLines("");
  return pythonLanguage;
}

function pythonSource(): string {
  const prefix = "# café appears before measured tokens\n";
  const unit = `@decorator
class RenderedItem[T]:
    async def render_item(self, value: T | None = None) -> str:
        label = f"value={value!r:>8}"
        return label
`;
  const encoder = new TextEncoder();
  let source = prefix;
  while (encoder.encode(source + unit).length + 3 <= TARGET_BYTES) {
    source += unit;
  }
  const remaining = TARGET_BYTES - encoder.encode(source).length;
  if (remaining > 0) source += `#${"x".repeat(remaining - 1)}`;
  if (encoder.encode(source).length !== TARGET_BYTES) {
    throw new Error("Python fixture has the wrong byte length");
  }
  return source;
}

function middleEdit(source: string) {
  const original = "render_item";
  const replacement = "render_unit";
  const startIndex = source.indexOf(original, Math.floor(source.length / 2));
  if (startIndex < 0) throw new Error("Middle edit target is absent");
  return {
    source: source.slice(0, startIndex) + replacement +
      source.slice(startIndex + original.length),
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
  await initializePython();
  console.log(JSON.stringify({ milliseconds: performance.now() - moduleStarted }));
  Deno.exit();
}

const python = await initializePython();
const source = pythonSource();
const edit = middleEdit(source);
if (reconstruct(python.highlightLines(source)) !== source) {
  throw new Error("Highlighting changed source");
}

const highlightSamples: number[] = [];
python.highlightLines(source);
for (let index = 0; index < WORK_SAMPLES; index++) {
  const started = performance.now();
  python.highlightLines(source);
  highlightSamples.push(performance.now() - started);
}

const documentSamples: number[] = [];
python.parseDocument(source);
for (let index = 0; index < WORK_SAMPLES; index++) {
  const started = performance.now();
  python.parseDocument(source);
  documentSamples.push(performance.now() - started);
}

const incrementalSamples: number[] = [];
for (let index = 0; index < WORK_SAMPLES + 1; index++) {
  const highlighter = python.createHighlighter(source);
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
    args: ["run", "--allow-read", "--allow-env", import.meta.filename!, "--cold"],
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
