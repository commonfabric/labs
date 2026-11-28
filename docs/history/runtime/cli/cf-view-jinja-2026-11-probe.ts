/**
 * Measures the shipped `cf view` Jinja path against the operating maximums
 * recorded in the `cf view` language coverage plan. It drives the real
 * language objects, selected by name as `--language` selects them, so what it
 * times is what the pager runs.
 *
 * Run it from `runtime/cli`, which is where the parser packages are declared,
 * naming the language to measure:
 *
 *   deno run --allow-read --allow-env --allow-run \
 *     ../../docs/history/runtime/cli/cf-view-jinja-2026-11-probe.ts jinja-shell
 *
 * The source size, the same-length middle edit, and the sample counts follow
 * the September 2026 Python, Swift, Kotlin, TOML, and shell measurements and
 * the October 2026 HCL measurement, so the runs compare directly. Naming
 * `shell` measures the shell language on the same source as `jinja-shell`,
 * and naming `toml` measures the TOML control run that calibrates a round
 * against the TOML figures already recorded.
 *
 * Each sample records the process's CPU time as well as the time that passed,
 * because on a machine with many more runnable threads than cores the time
 * that passes is mostly time spent waiting for a core.
 */

import process from "node:process";

/** The CPU time this process has used, in milliseconds. */
function cpuNow(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}

const moduleStarted = performance.now();
const moduleStartedCpu = cpuNow();
const STARTUP_SAMPLES = 40;
const WORK_SAMPLES = 50;
const TARGET_BYTES = 100_009;

interface Subject {
  /** The name `languageForName` resolves. */
  readonly language: string;
  readonly prefix: string;

  /** The repeated source, given how many units precede it. */
  readonly unit: (index: number) => string;
  readonly original: string;
  readonly replacement: string;
  readonly filler: string;
}

/** A deploy function in the shape of the Infra repository's shell templates. */
const shellTemplate = (index: number) =>
  `{% if deploy_enabled | default(true) %}
deploy_item_${index}() {
  cd "{{ labs_repo_path }}/{{ item.name | quote }}" || exit 1
  git fetch origin {{ branch | default('main') }} && echo "\${HOME} ${index}"
}
{% endif %}
`;

const SUBJECTS: Readonly<Record<string, Subject>> = {
  "jinja-shell": {
    language: "jinja-shell",
    prefix: "# café appears before measured tokens\n",
    unit: shellTemplate,
    original: "deploy_item",
    replacement: "deploy_unit",
    filler: "#",
  },
  shell: {
    language: "shell",
    prefix: "# café appears before measured tokens\n",
    unit: shellTemplate,
    original: "deploy_item",
    replacement: "deploy_unit",
    filler: "#",
  },
  "jinja-yaml": {
    language: "jinja-yaml",
    prefix: "# café appears before measured tokens\n",
    // A pipeline in the shape of the Infra repository's collector templates.
    unit: (index) => `pipeline_${index}:
  receivers: [{{ receivers | join(", ") }}]
{% for name in exporters %}
  {{ name }}_${index}:
    level: {{ level | default("info") }}
{% endfor %}
`,
    original: "level",
    replacement: "depth",
    filler: "#",
  },
  toml: {
    language: "toml",
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

const subjectName = Deno.args.find((arg) => !arg.startsWith("--")) ?? "";
const subject = SUBJECTS[subjectName];
if (subject === undefined) {
  throw new Error(`Name one of: ${Object.keys(SUBJECTS).join(", ")}`);
}

/** Load the language and its parser, then color an empty source. */
async function initialize() {
  const { languageForName } = await import(
    "../../../../runtime/cli/lib/view/languages/language.ts"
  );
  const language = languageForName(subject.language);
  if (language === undefined) throw new Error("Unknown language");
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

function middleEdit(source: string): string {
  const startIndex = source.indexOf(
    subject.original,
    Math.floor(source.length / 2),
  );
  if (startIndex < 0) throw new Error("Middle edit target is absent");
  return source.slice(0, startIndex) + subject.replacement +
    source.slice(startIndex + subject.original.length);
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

function summary(samples: readonly number[]) {
  return { samples, median: median(samples), p95: p95(samples) };
}

/** Times `work` `count` times, in passing time and in CPU time. */
function measure(count: number, work: () => void) {
  const wall: number[] = [];
  const cpu: number[] = [];
  for (let index = 0; index < count; index++) {
    const started = performance.now();
    const startedCpu = cpuNow();
    work();
    cpu.push(cpuNow() - startedCpu);
    wall.push(performance.now() - started);
  }
  return { wall: summary(wall), cpu: summary(cpu) };
}

if (Deno.args.includes("--cold")) {
  await initialize();
  console.log(JSON.stringify({
    milliseconds: performance.now() - moduleStarted,
    cpuMilliseconds: cpuNow() - moduleStartedCpu,
  }));
  Deno.exit();
}

const language = await initialize();
const source = measuredSource();
const edited = middleEdit(source);
if (reconstruct(language.highlightLines(source)) !== source) {
  throw new Error("Highlighting changed source");
}

language.highlightLines(source);
const fullHighlight = measure(WORK_SAMPLES, () => {
  language.highlightLines(source);
});

language.parseDocument(source);
const parseDocument = measure(WORK_SAMPLES, () => {
  language.parseDocument(source);
});

// Each sample edits a fresh highlighter, which is built outside the timing.
const highlighters = Array.from(
  { length: WORK_SAMPLES + 1 },
  () => language.createHighlighter(source),
);
if (reconstruct(highlighters[0].update(edited)) !== edited) {
  throw new Error("An update changed source");
}
let next = 1;
const recolor = measure(WORK_SAMPLES, () => {
  highlighters[next++].update(edited);
});

const startupSamples: number[] = [];
const startupCpuSamples: number[] = [];
for (let index = 0; index < STARTUP_SAMPLES; index++) {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-env",
      import.meta.filename ?? "",
      subjectName,
      "--cold",
    ],
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!output.success) throw new Error("Cold-start child failed");
  const cold = JSON.parse(new TextDecoder().decode(output.stdout));
  startupSamples.push(cold.milliseconds);
  startupCpuSamples.push(cold.cpuMilliseconds);
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
      wall: summary(startupSamples),
      cpu: summary(startupCpuSamples),
    },
    fullHighlightMilliseconds: fullHighlight,
    parseDocumentMilliseconds: parseDocument,
    recolorMilliseconds: recolor,
  },
  null,
  2,
));
