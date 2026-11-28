/**
 * Measures the shipped `cf view` Rust path against the operating maximums
 * recorded in the `cf view` language coverage plan, beside the shipped TOML
 * and HCL paths as controls. It drives the real language objects, so what it
 * times is what the pager runs.
 *
 * Run it from `runtime/cli`, which is where the parser packages are declared:
 *
 *   deno run --allow-read --allow-env --allow-run \
 *     ../../docs/history/packages/cli/cf-view-rust-2026-11-probe.ts
 *
 * The source size, the same-length middle edit, the sample counts, and the
 * operations timed follow the September 2026 Python, Swift, Kotlin, TOML, and
 * shell measurements and the October 2026 HCL measurement, so the runs compare
 * directly. Those probes measured one language per run, and a round ran the
 * TOML control before and after it. This one takes each Rust sample and then
 * the matching TOML and HCL samples, so that all three see the same load on a
 * shared machine, and reports the ratio of Rust to each control. It
 * records the processor time each sample takes beside its wall-clock time.
 * The work is synchronous, so on an idle machine the two agree, and on a
 * loaded one the processor time leaves out the time the process waits to be
 * scheduled.
 */

import { cpuUsage } from "node:process";
import type { Language } from "../../../../runtime/cli/lib/view/languages/language.ts";

/** Wall-clock and processor time, in milliseconds. */
interface Timing {
  readonly wall: number;
  readonly cpu: number;
}

/** Wall-clock and processor time since `start`. */
function since(start: { wall: number; cpu: ReturnType<typeof cpuUsage> }): Timing {
  const { user, system } = cpuUsage(start.cpu);
  return { wall: performance.now() - start.wall, cpu: (user + system) / 1000 };
}

function now() {
  return { wall: performance.now(), cpu: cpuUsage() };
}

const moduleStarted = now();
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
  rust: {
    module: "rust/language.ts",
    exported: "rustLanguage",
    prefix: "// café appears before measured tokens\n",
    // Each implementation is for its own type, since a type implements a
    // trait only once.
    unit: (index) => `impl Render for Item${index} {
    fn render_item(&self, scale: f64) -> Option<String> {
        let label = format!("{}-{}", self.name, scale * 2.5);
        if self.parts.iter().any(|part| part.len() > 3) { Some(label) } else { None }
    }
}
`,
    original: "render_item",
    replacement: "render_unit",
    filler: "//",
  },
  hcl: {
    module: "hcl/language.ts",
    exported: "hclLanguage",
    prefix: "# café appears before measured tokens\n",
    // Each resource has its own name, since a configuration declares a
    // resource only once.
    unit: (index) => `resource "google_compute_instance" "render_item_${index}" {
  count   = var.enabled ? 1 : 0
  name    = "\${var.prefix}-\${count.index}"
  zones   = [for z in local.zones : upper(z) if z != ""]
  labels  = { team = "ci", size = 2.5 }
}
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

const NAMES = ["rust", "toml", "hcl"] as const;

/** Load the language and its parser, then color an empty source. */
async function initialize(subject: Subject): Promise<Language> {
  const module = await import(
    `../../../../runtime/cli/lib/view/languages/${subject.module}`
  );
  const language: Language = module[subject.exported];
  await language.prepare!();
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

const coldSubject = Deno.args[0] === "--cold" ? SUBJECTS[Deno.args[1]] : null;
if (coldSubject !== null) {
  await initialize(coldSubject);
  console.log(
    JSON.stringify(since(moduleStarted)),
  );
  Deno.exit();
}

const languages: Record<string, Language> = {};
const sources: Record<string, string> = {};
const edited: Record<string, string> = {};
for (const name of NAMES) {
  languages[name] = await initialize(SUBJECTS[name]);
  sources[name] = measuredSource(SUBJECTS[name]);
  edited[name] = middleEdit(SUBJECTS[name], sources[name]);
  if (reconstruct(languages[name].highlightLines(sources[name])) !== sources[name]) {
    throw new Error("Highlighting changed source");
  }
  languages[name].parseDocument(sources[name]);
}

type Samples = Record<(typeof NAMES)[number], Timing[]>;
const empty = (): Samples => ({ rust: [], toml: [], hcl: [] });

/** Times `operation` for each language in turn, `count` times over. */
async function paired(
  count: number,
  operation: (name: (typeof NAMES)[number]) => Timing | Promise<Timing>,
): Promise<Samples> {
  const samples = empty();
  for (let index = 0; index < count; index++) {
    for (const name of NAMES) samples[name].push(await operation(name));
  }
  return samples;
}

function timed(work: () => void): Timing {
  const started = now();
  work();
  return since(started);
}

const operations: Record<string, Samples> = {
  fullHighlightMilliseconds: await paired(
    WORK_SAMPLES,
    (name) => timed(() => languages[name].highlightLines(sources[name])),
  ),
  parseDocumentMilliseconds: await paired(
    WORK_SAMPLES,
    (name) => timed(() => languages[name].parseDocument(sources[name])),
  ),
  incrementalEditMilliseconds: await paired(WORK_SAMPLES, (name) => {
    const highlighter = languages[name].createHighlighter(sources[name]);
    let updated: ReturnType<typeof highlighter.update> = [];
    const timing = timed(() => {
      updated = highlighter.update(edited[name]);
    });
    if (reconstruct(updated) !== edited[name]) {
      throw new Error("An incremental update changed source");
    }
    return timing;
  }),
  startupMilliseconds: await paired(STARTUP_SAMPLES, async (name) => {
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-env",
        import.meta.filename!,
        "--cold",
        name,
      ],
      stdout: "piped",
      stderr: "inherit",
    }).output();
    if (!output.success) throw new Error("Cold-start child failed");
    return JSON.parse(new TextDecoder().decode(output.stdout));
  }),
};

console.log(JSON.stringify(
  {
    environment: {
      deno: Deno.version.deno,
      v8: Deno.version.v8,
      typescript: Deno.version.typescript,
      os: Deno.build.os,
      arch: Deno.build.arch,
    },
    fixtureBytes: TARGET_BYTES,
    operations: Object.fromEntries(
      Object.entries(operations).map(([operation, samples]) => [
        operation,
        Object.fromEntries((["wall", "cpu"] as const).map((clock) => {
          const of = (name: (typeof NAMES)[number]) =>
            samples[name].map((timing) => timing[clock]);
          return [clock, {
            ...Object.fromEntries(NAMES.map((name) => [name, {
              samples: of(name),
              median: median(of(name)),
              p95: p95(of(name)),
            }])),
            ...Object.fromEntries(NAMES.slice(1).map((control) => [
              `ratioTo${control}`,
              {
                median: median(of("rust")) / median(of(control)),
                p95: p95(of("rust")) / p95(of(control)),
              },
            ])),
          }];
        })),
      ]),
    ),
  },
  null,
  2,
));
