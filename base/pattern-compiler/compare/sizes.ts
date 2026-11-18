/**
 * The size of what the crate emits for each module of the corpus: the
 * plan of each pattern with its largest members, and the value code, with
 * the time the crate takes for the whole corpus. It lists the largest, so
 * that a size that grows faster than the source shows.
 *
 * `deno run -A base/pattern-compiler/compare/sizes.ts [binary] [--json]`
 *
 * `binary` is the crate's executable, and the release build of this tree
 * where none is given. With `--json` it prints one line per pattern.
 */
import { fromFileUrl } from "@std/path";

const repository = fromFileUrl(new URL("../../../", import.meta.url));
const patterns = `${repository}patterns`;

/** One pattern of the corpus, measured. */
export type PatternSize = {
  module: string;
  pattern: string;
  /** The bytes of the source files of the module's program. */
  source: number;
  /** The bytes of the plan as compact JSON. */
  plan: number;
  /** The bytes of each member of the plan, largest first. */
  members: [string, number][];
  /** The bytes of the value code. */
  code: number;
};

const bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value) ?? "").length;

/**
 * Measures every pattern that `binary` emits for the corpus, and the
 * milliseconds of the one run of the crate that emits them all.
 */
export const measure = async (
  binary: string,
): Promise<{ sizes: PatternSize[]; milliseconds: number }> => {
  const started = performance.now();
  const listed = await new Deno.Command(binary, {
    args: ["emit", "--corpus", "."],
    cwd: patterns,
  }).output();
  const milliseconds = Math.round(performance.now() - started);
  if (!listed.success) throw new Error(new TextDecoder().decode(listed.stderr));
  const modules = new TextDecoder().decode(listed.stdout).split("\n").filter((
    line,
  ) => line.length > 0).map((line) =>
    JSON.parse(line) as {
      module: string;
      patterns: {
        name: string;
        plan: Record<string, unknown>;
        code?: { modules?: { path: string; source: string }[] };
      }[];
    }
  );
  const sizes: PatternSize[] = [];
  for (const module of modules) {
    for (const pattern of module.patterns) {
      const texts = pattern.code?.modules ?? [];
      sizes.push({
        module: module.module,
        pattern: pattern.name,
        source: texts.reduce((sum, { source }) => sum + source.length, 0),
        plan: bytes(pattern.plan),
        members: Object.entries(pattern.plan).map((
          [name, member],
        ): [string, number] => [name, bytes(member)]).sort((a, b) =>
          b[1] - a[1]
        ).slice(0, 4),
        code: bytes(pattern.code?.modules),
      });
    }
  }
  return { sizes, milliseconds };
};

if (import.meta.main) {
  const json = Deno.args.includes("--json");
  const binary = Deno.args.find((argument) => !argument.startsWith("--")) ??
    `${repository}base/pattern-compiler/target/release/pattern-compiler`;
  const { sizes, milliseconds } = await measure(binary);
  if (json) {
    for (const size of sizes) console.log(JSON.stringify(size));
  } else {
    const total = (of: (size: PatternSize) => number) =>
      sizes.reduce((sum, size) => sum + of(size), 0);
    console.log(`patterns: ${sizes.length}`);
    console.log(`the crate's run over the corpus: ${milliseconds} ms`);
    console.log(`plans, bytes in all: ${total((size) => size.plan)}`);
    console.log(`value code, bytes in all: ${total((size) => size.code)}`);
    const show = (title: string, of: (size: PatternSize) => number) => {
      console.log(title);
      for (
        const size of [...sizes].sort((a, b) => of(b) - of(a)).slice(0, 12)
      ) {
        console.log(
          `  ${of(size).toFixed(1)}  ${size.module} ${size.pattern}: plan ` +
            `${size.plan}, code ${size.code}, source ${size.source}; ${
              size.members.map(([name, at]) => `${name} ${at}`).join(", ")
            }`,
        );
      }
    };
    show("the largest plans, by bytes:", (size) => size.plan);
    show(
      "the largest plans for their source, by bytes of plan per byte of source:",
      (size) => size.source === 0 ? 0 : size.plan / size.source,
    );
  }
}
