/**
 * Measures the shipped `cf view` CSS path against the operating maximums
 * recorded in the `cf view` language coverage plan, beside the TOML path as a
 * control. It drives the real language objects, so what it times is what the
 * pager runs.
 *
 * Run it from `runtime/cli`, which is where the parser packages are declared,
 * naming the languages to measure:
 *
 *   deno run --allow-read --allow-env --allow-run \
 *     ../../docs/history/packages/cli/cf-view-css-2026-11-probe.ts css toml
 *
 * The source size, the same-length middle edit, the operations timed, and the
 * sample counts follow the September 2026 Python, Swift, Kotlin, TOML, and
 * shell measurements and the October 2026 HCL measurement, so the runs compare
 * directly, and the TOML source is theirs byte for byte. Where those probes
 * measured one language in each process, this one takes each sample of every
 * named language in turn, in one process and in alternating fresh processes,
 * so that the languages share whatever load the machine is under.
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
  /** What ends the filler, so that the source parses without an error. */
  readonly fillerEnd: string;
}

const SUBJECTS: Readonly<Record<string, Subject>> = {
  css: {
    module: "css/language.ts",
    exported: "cssLanguage",
    prefix: "/* café appears before measured tokens */\n",
    // Each rule has its own selectors and custom property, as a style sheet's
    // rules for different components do.
    unit: (index) =>
      `.render-item-${index} > a:hover, #panel-${index}[data-state="open"] {
  --gap-${index}: 4px;
  margin: 0 auto;
  padding: var(--gap-${index}) calc(1em + 2px);
  color: #3a7bd5;
  background: url(icons/item.svg) no-repeat center / 16px;
}
`,
    original: "render-item",
    replacement: "render-unit",
    filler: "/*",
    fillerEnd: "*/",
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
    fillerEnd: "",
  },
};

const names = Deno.args.filter((arg) => !arg.startsWith("--"));
const subjects = names.map((name) => {
  const subject = SUBJECTS[name];
  if (subject === undefined) {
    throw new Error(`Name one of: ${Object.keys(SUBJECTS).join(", ")}`);
  }
  return subject;
});
if (subjects.length === 0) {
  throw new Error(`Name one of: ${Object.keys(SUBJECTS).join(", ")}`);
}

interface Line {
  readonly spans: readonly { readonly text: string }[];
}

/** The parts of a language object the probe drives. */
interface MeasuredLanguage {
  prepare(): Promise<void>;
  highlightLines(text: string): Line[];
  parseDocument(text: string): unknown;
  createHighlighter(text: string): { update(next: string): readonly Line[] };
}

/** Load a language and its parser, then color an empty source. */
async function initialize(subject: Subject): Promise<MeasuredLanguage> {
  const module = await import(
    `../../../../runtime/cli/lib/view/languages/${subject.module}`
  );
  const language: MeasuredLanguage = module[subject.exported];
  await language.prepare();
  language.highlightLines("");
  return language;
}

function measuredSource(subject: Subject): string {
  const encoder = new TextEncoder();
  // Room for the filler and its end, and at least the three bytes the earlier
  // probes left, so that the TOML source is theirs.
  const room = Math.max(
    3,
    subject.filler.length + subject.fillerEnd.length + 1,
  );
  let source = subject.prefix;
  for (let index = 0;; index++) {
    const unit = subject.unit(index);
    if (encoder.encode(source + unit).length + room > TARGET_BYTES) break;
    source += unit;
  }
  const remaining = TARGET_BYTES - encoder.encode(source).length;
  if (remaining > 0) {
    source += subject.filler +
      "x".repeat(
        remaining - subject.filler.length - subject.fillerEnd.length,
      ) + subject.fillerEnd;
  }
  if (encoder.encode(source).length !== TARGET_BYTES) {
    throw new Error("The measured source has the wrong byte length");
  }
  return source;
}

function middleEdit(subject: Subject, source: string): string {
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

function reconstruct(lines: readonly Line[]): string {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

if (Deno.args.includes("--cold")) {
  await initialize(subjects[0]);
  console.log(
    JSON.stringify({ milliseconds: performance.now() - moduleStarted }),
  );
  Deno.exit();
}

const runs = await Promise.all(subjects.map(async (subject) => {
  const language = await initialize(subject);
  const source = measuredSource(subject);
  const edited = middleEdit(subject, source);
  if (reconstruct(language.highlightLines(source)) !== source) {
    throw new Error("Highlighting changed source");
  }
  return {
    language,
    source,
    edited,
    startup: [] as number[],
    highlight: [] as number[],
    document: [] as number[],
    edit: [] as number[],
  };
}));

/** Time the operation `prepare` sets up, once for each language in turn,
 * `WORK_SAMPLES` times after one turn that is not recorded. Only the operation
 * is timed; `check` reads its result afterwards. */
function sample<T>(
  record: (run: (typeof runs)[number]) => number[],
  prepare: (run: (typeof runs)[number]) => () => T,
  check: (run: (typeof runs)[number], result: T) => void = () => {},
): void {
  for (let index = 0; index <= WORK_SAMPLES; index++) {
    for (const run of runs) {
      const operation = prepare(run);
      const started = performance.now();
      const result = operation();
      const milliseconds = performance.now() - started;
      check(run, result);
      if (index > 0) record(run).push(milliseconds);
    }
  }
}

sample(
  (run) => run.highlight,
  (run) => () => run.language.highlightLines(run.source),
);
sample(
  (run) => run.document,
  (run) => () => run.language.parseDocument(run.source),
);
sample(
  (run) => run.edit,
  (run) => {
    const highlighter = run.language.createHighlighter(run.source);
    return () => highlighter.update(run.edited);
  },
  (run, lines) => {
    if (reconstruct(lines) !== run.edited) {
      throw new Error("An incremental update changed source");
    }
  },
);

for (let index = 0; index < STARTUP_SAMPLES; index++) {
  for (const [at, run] of runs.entries()) {
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        import.meta.filename!,
        names[at],
        "--cold",
      ],
      stdout: "piped",
      stderr: "inherit",
    }).output();
    if (!output.success) throw new Error("Cold-start child failed");
    run.startup.push(
      JSON.parse(new TextDecoder().decode(output.stdout)).milliseconds,
    );
  }
}

const summary = (samples: readonly number[]) => ({
  samples,
  median: median(samples),
  p95: p95(samples),
});
console.log(JSON.stringify(
  {
    environment: {
      deno: Deno.version.deno,
      v8: Deno.version.v8,
      typescript: Deno.version.typescript,
      os: Deno.build.os,
      arch: Deno.build.arch,
    },
    languages: Object.fromEntries(runs.map((run, at) => [names[at], {
      fixtureBytes: new TextEncoder().encode(run.source).length,
      startupMilliseconds: summary(run.startup),
      fullHighlightMilliseconds: summary(run.highlight),
      parseDocumentMilliseconds: summary(run.document),
      incrementalEditMilliseconds: summary(run.edit),
    }])),
  },
  null,
  2,
));
