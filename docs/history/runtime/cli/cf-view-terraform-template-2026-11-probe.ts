/**
 * Measures the shipped `cf view` Terraform template path over shell against
 * the operating maximums recorded in the `cf view` language coverage plan. It
 * drives the real language objects, so what it times is what the pager runs.
 *
 * Run it from `runtime/cli`, which is where the parser packages are declared:
 *
 *   deno run --allow-read --allow-env --allow-run \
 *     ../../docs/history/runtime/cli/cf-view-terraform-template-2026-11-probe.ts
 *
 * The source size, the same-length middle edit, and the sample counts follow
 * the October 2026 HCL measurement, and the TOML and shell sources follow the
 * September 2026 measurements of those languages, so the runs compare
 * directly. One run measures six sources: the template over shell, on the
 * shared fixture's Infra template repeated, on the shell measurement's source
 * with template sequences added, on a source with an interpolation on every
 * line, and on that source with two of each unit's three interpolations not
 * valid HCL; the TOML control that calibrates a run against the TOML figures
 * already recorded; and shell alone on the shell measurement's source. Their
 * samples interleave, each sample of each operation taking one measurement of
 * each in a rotating order, so that all six are measured under the same load
 * on a shared machine.
 */

import type { Language } from "../../../../runtime/cli/lib/view/languages/language.ts";

const moduleStarted = performance.now();
const STARTUP_SAMPLES = 40;
const WORK_SAMPLES = 50;
const TARGET_BYTES = 100_009;

interface Subject {
  /** The language's name, as `cf view --language` accepts it. */
  readonly name: string;
  readonly prefix: string;
  /** The repeated source, given how many units precede it. */
  readonly unit: (index: number) => string;
  readonly original: string;
  readonly replacement: string;
  readonly filler: string;
}

/** The shared fixture's template from the Infra repository. */
const INFRA_TEMPLATE = Deno.readTextFileSync(
  new URL(
    "../../../../runtime/cli/test/fixtures/view-language/terraform-template-infra/after.sh.tftpl",
    import.meta.url,
  ),
);

const SUBJECTS: Readonly<Record<string, Subject>> = {
  // The Infra repository's template, repeated, which has as many sequences
  // for its size as the Infra repository's templates have.
  "terraform-template-shell-infra": {
    name: "terraform-template-shell",
    prefix: "# café appears before measured tokens\n",
    unit: () => INFRA_TEMPLATE,
    original: "install_preemption_watcher",
    replacement: "install_preemption_watchex",
    filler: "#",
  },
  // The shell measurement's unit, with an escape and an interpolation in its
  // second line, an interpolation in its fourth, and two directives around a
  // line. Each interpolation names a variable of its own, as a template's
  // interpolations name its variables.
  "terraform-template-shell": {
    name: "terraform-template-shell",
    prefix: "# café appears before measured tokens\n",
    unit: (index) =>
      `render_item() {
  local label="value=$\${1:-none} $(date +%s) \${prefix_${index}}"
  if [[ -n "$label" && $2 =~ ^v[0-9]+$ ]]; then
    printf '%s\\n' "$label" "\${upper(suffix_${index})}" >&2
  fi
%{ if debug ~}
  set -x
%{ endif ~}
  return 0
}
`,
    original: "render_item",
    replacement: "render_unit",
    filler: "#",
  },
  // A template with an interpolation on every line, which each name a
  // variable of their own, and an escape on one.
  "terraform-template-shell-dense": {
    name: "terraform-template-shell",
    prefix: "# café appears before measured tokens\n",
    unit: (index) =>
      `export A_${index}="\${a_${index}}"
export B_${index}="\${lower(b_${index})}"
render_item() { echo "$\${A_${index}}" "\${join(",", c_${index})}"; }
`,
    original: "render_item",
    replacement: "render_unit",
    filler: "#",
  },
  // The dense source with each unit's first two interpolations not valid HCL.
  "terraform-template-shell-broken": {
    name: "terraform-template-shell",
    prefix: "# café appears before measured tokens\n",
    unit: (index) =>
      `export A_${index}="\${a_${index} + }"
export B_${index}="\${lower(b_${index}, }"
render_item() { echo "$\${A_${index}}" "\${join(",", c_${index})}"; }
`,
    original: "render_item",
    replacement: "render_unit",
    filler: "#",
  },
  shell: {
    name: "shell",
    prefix: "# café appears before measured tokens\n",
    unit: () =>
      `render_item() {
  local label="value=\${1:-none} $(date +%s)"
  if [[ -n "$label" && $2 =~ ^v[0-9]+$ ]]; then
    printf '%s\\n' "$label" >&2
  fi
  return 0
}
`,
    original: "render_item",
    replacement: "render_unit",
    filler: "#",
  },
  toml: {
    name: "toml",
    prefix: "# café appears before measured tokens\n",
    // Each table has its own name, since TOML defines a table only once.
    unit: (index) =>
      `[libraries.item${index}]
group = "androidx.compose.ui"
name = "renderItem"
version = { ref = "compose", strictly = [1, 2.5, true] }
`,
    original: "renderItem",
    replacement: "renderUnit",
    filler: "#",
  },
};

/** A language the probe drives, by its name, with its measured source. */
interface Loaded {
  readonly name: string;
  readonly language: Language;
  readonly source: string;
  readonly edited: string;
}

/** Load a language and its parsers, then color an empty source. */
async function initialize(name: string): Promise<Language> {
  const { languageForName } = await import(
    "../../../../runtime/cli/lib/view/languages/language.ts"
  );
  const language = languageForName(SUBJECTS[name].name);
  if (language === undefined) throw new Error(`No language named ${name}`);
  await language.prepare?.();
  language.highlightLines("");
  return language;
}

function measuredSource(subject: Subject): string {
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

function reconstruct(lines: readonly { spans: readonly { text: string }[] }[]) {
  return lines.map((line) => line.spans.map((span) => span.text).join(""))
    .join("\n");
}

function summary(samples: readonly number[]) {
  return { samples, median: median(samples), p95: p95(samples) };
}

const cold = Deno.args.indexOf("--cold");
if (cold >= 0) {
  await initialize(Deno.args[cold + 1]);
  console.log(
    JSON.stringify({ milliseconds: performance.now() - moduleStarted }),
  );
  Deno.exit();
}

const loaded: Loaded[] = [];
for (const name of Object.keys(SUBJECTS)) {
  const language = await initialize(name);
  const source = measuredSource(SUBJECTS[name]);
  if (reconstruct(language.highlightLines(source)) !== source) {
    throw new Error(`Highlighting changed the ${name} source`);
  }
  loaded.push({
    name,
    language,
    source,
    edited: middleEdit(SUBJECTS[name], source),
  });
}

/**
 * Times `operation` for every language once per sample, in an order that
 * rotates each sample, so that every language's samples are taken under the
 * same load. One untimed run of each comes first.
 */
function interleaved(operation: (subject: Loaded) => number): number[][] {
  const samples = loaded.map((): number[] => []);
  for (const subject of loaded) operation(subject);
  for (let sample = 0; sample < WORK_SAMPLES; sample++) {
    for (let turn = 0; turn < loaded.length; turn++) {
      const index = (sample + turn) % loaded.length;
      samples[index].push(operation(loaded[index]));
    }
  }
  return samples;
}

function timed(work: () => void): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

const highlight = interleaved(({ language, source }) =>
  timed(() => language.highlightLines(source))
);
const document = interleaved(({ language, source }) =>
  timed(() => language.parseDocument(source))
);
const recolor = interleaved(({ language, source, edited }) => {
  const highlighter = language.createHighlighter(source);
  const started = performance.now();
  const updated = highlighter.update(edited);
  const milliseconds = performance.now() - started;
  if (reconstruct(updated) !== edited) {
    throw new Error("An incremental update changed source");
  }
  return milliseconds;
});

// A language's initialization is measured once, for the first source that
// uses it.
const startup = loaded.map((): number[] => []);
const initialized = loaded.flatMap(({ name }, index) =>
  loaded.findIndex((other) =>
      SUBJECTS[other.name].name === SUBJECTS[name].name
    ) === index
    ? [index]
    : []
);
for (let sample = 0; sample < STARTUP_SAMPLES; sample++) {
  for (let turn = 0; turn < initialized.length; turn++) {
    const index = initialized[(sample + turn) % initialized.length];
    const { name } = loaded[index];
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        import.meta.filename ?? "",
        "--cold",
        name,
      ],
      stdout: "piped",
      stderr: "inherit",
    }).output();
    if (!output.success) throw new Error("Cold-start child failed");
    startup[index].push(
      JSON.parse(new TextDecoder().decode(output.stdout)).milliseconds,
    );
  }
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
    languages: Object.fromEntries(
      loaded.map(({ name, source }, index) => [name, {
        fixtureBytes: new TextEncoder().encode(source).length,
        startupMilliseconds: startup[index].length === 0
          ? null
          : summary(startup[index]),
        fullHighlightMilliseconds: summary(highlight[index]),
        parseDocumentMilliseconds: summary(document[index]),
        incrementalEditMilliseconds: summary(recolor[index]),
      }]),
    ),
  },
  null,
  2,
));
