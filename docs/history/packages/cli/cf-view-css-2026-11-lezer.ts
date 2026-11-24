/**
 * Compares the Lezer CSS parser that the UI package pins, through
 * `@codemirror/lang-css`, with the Tree-sitter CSS grammar the `cf view` CSS
 * language uses. It parses the 100-kilobyte source of the adjacent probe with
 * each, in one process and in alternation, and counts the regions each cannot
 * parse in every CSS file of the named Git repositories, read from the named
 * commit of each. With `--cold PARSER`, it instead times loading one parser and
 * parsing an empty source in a fresh process.
 *
 * Run it from `runtime/cli`, which is where the Tree-sitter packages are
 * declared, with a copy of the repository's lock file named by `LEZER_LOCK`,
 * so that the Lezer packages resolve to the versions the lock file holds for
 * the UI package and the repository's own lock file is left as it is:
 *
 *   export LEZER_LOCK="$TMPDIR/lezer.lock"
 *   cp ../../deno.lock "$LEZER_LOCK"
 *   deno run --lock="$LEZER_LOCK" --allow-read --allow-env --allow-run \
 *     ../../docs/history/packages/cli/cf-view-css-2026-11-lezer.ts \
 *     DIR:COMMIT...
 */

const moduleStarted = performance.now();
const STARTUP_SAMPLES = 40;
const WORK_SAMPLES = 50;

type Parse = (source: string) => {
  /** The rows of the regions the parser could not parse. */
  errorRows: () => Set<number>;
};

/** Each parser, loaded on demand so that a cold start loads only one. */
const PARSERS: Readonly<Record<string, () => Promise<Parse>>> = {
  async lezer() {
    const { parser } = await import("npm:@lezer/css@1.3.0");
    return (source) => {
      const tree = parser.parse(source);
      return {
        errorRows() {
          const rows = new Set<number>();
          tree.iterate({
            enter(node) {
              if (!node.type.isError) return;
              const first = rowOf(source, node.from);
              const last = rowOf(source, node.to);
              for (let row = first; row <= last; row++) rows.add(row);
            },
          });
          return rows;
        },
      };
    };
  },

  async "tree-sitter"() {
    const { Language, Parser } = await import("npm:web-tree-sitter@0.26.12");
    const { cssGrammar } = await import(
      "../../../../runtime/cli/lib/view/languages/css/css.ts"
    );
    await Parser.init();
    const parser = new Parser();
    parser.setLanguage(
      await Language.load(await Deno.readFile(new URL(cssGrammar.wasmUrl()))),
    );
    return (source) => {
      const tree = parser.parse(source)!;
      const rows = new Set<number>();
      const visit = (node: typeof tree.rootNode) => {
        const holding = node.children.filter((child) => child.hasError);
        if (node.type === "ERROR" || holding.length === 0) {
          for (
            let row = node.startPosition.row;
            row <= node.endPosition.row;
            row++
          ) {
            rows.add(row);
          }
          return;
        }
        for (const child of holding) visit(child);
      };
      if (tree.rootNode.hasError) visit(tree.rootNode);
      tree.delete();
      return { errorRows: () => rows };
    };
  },
};

function rowOf(source: string, offset: number): number {
  let row = 0;
  for (let index = source.indexOf("\n"); index >= 0 && index < offset;) {
    row++;
    index = source.indexOf("\n", index + 1);
  }
  return row;
}

/** The adjacent probe's 100,009-byte CSS source. */
function measuredSource(): string {
  const encoder = new TextEncoder();
  let source = "/* café appears before measured tokens */\n";
  for (let index = 0;; index++) {
    const unit =
      `.render-item-${index} > a:hover, #panel-${index}[data-state="open"] {
  --gap-${index}: 4px;
  margin: 0 auto;
  padding: var(--gap-${index}) calc(1em + 2px);
  color: #3a7bd5;
  background: url(icons/item.svg) no-repeat center / 16px;
}
`;
    if (encoder.encode(source + unit).length + 5 > 100_009) break;
    source += unit;
  }
  const remaining = 100_009 - encoder.encode(source).length;
  return source + "/*" + "x".repeat(remaining - 4) + "*/";
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

async function git(dir: string, ...args: string[]): Promise<string> {
  const { success, stdout, stderr } = await new Deno.Command("git", {
    args: ["-C", dir, ...args],
  }).output();
  if (!success) throw new Error(new TextDecoder().decode(stderr));
  return new TextDecoder().decode(stdout);
}

if (Deno.args[0] === "--cold") {
  (await PARSERS[Deno.args[1]]())("");
  console.log(
    JSON.stringify({ milliseconds: performance.now() - moduleStarted }),
  );
  Deno.exit();
}

const lockCopy = Deno.env.get("LEZER_LOCK");
if (lockCopy === undefined) {
  throw new Error("Name a copy of the lock file in LEZER_LOCK.");
}

const parse = {
  lezer: await PARSERS.lezer(),
  treeSitter: await PARSERS["tree-sitter"](),
};

const source = measuredSource();
const parseSamples = { lezer: [] as number[], treeSitter: [] as number[] };
for (let index = 0; index <= WORK_SAMPLES; index++) {
  for (const name of ["lezer", "treeSitter"] as const) {
    const started = performance.now();
    parse[name](source);
    const milliseconds = performance.now() - started;
    if (index > 0) parseSamples[name].push(milliseconds);
  }
}

const startupSamples = { lezer: [] as number[], treeSitter: [] as number[] };
for (let index = 0; index < STARTUP_SAMPLES; index++) {
  for (
    const [name, parser] of [["lezer", "lezer"], [
      "treeSitter",
      "tree-sitter",
    ]] as const
  ) {
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        `--lock=${lockCopy}`,
        "--allow-read",
        "--allow-env",
        import.meta.filename!,
        "--cold",
        parser,
      ],
      stdout: "piped",
      stderr: "inherit",
    }).output();
    if (!output.success) throw new Error("Cold-start child failed");
    startupSamples[name].push(
      JSON.parse(new TextDecoder().decode(output.stdout)).milliseconds,
    );
  }
}

const errors = {
  lezer: { files: 0, lines: 0, byFile: {} as Record<string, number> },
  treeSitter: { files: 0, lines: 0, byFile: {} as Record<string, number> },
};
let files = 0;
let lines = 0;
for (const argument of Deno.args) {
  const split = argument.lastIndexOf(":");
  const dir = argument.slice(0, split);
  const commit = argument.slice(split + 1);
  const paths = (await git(dir, "ls-tree", "-r", "--name-only", commit))
    .split("\n").filter((path) => /\.css$/i.test(path));
  for (const path of paths) {
    const text = await git(dir, "show", `${commit}:${path}`);
    files++;
    lines += text.split("\n").length;
    for (const name of ["lezer", "treeSitter"] as const) {
      const rows = parse[name](text).errorRows();
      if (rows.size === 0) continue;
      errors[name].files++;
      errors[name].lines += rows.size;
      errors[name].byFile[`${dir}:${path}`] = rows.size;
    }
  }
}

const summary = (samples: readonly number[]) => ({
  samples,
  median: median(samples),
  p95: p95(samples),
});
console.log(JSON.stringify(
  {
    fixtureBytes: new TextEncoder().encode(source).length,
    startupMilliseconds: {
      lezer: summary(startupSamples.lezer),
      treeSitter: summary(startupSamples.treeSitter),
    },
    parseMilliseconds: {
      lezer: summary(parseSamples.lezer),
      treeSitter: summary(parseSamples.treeSitter),
    },
    files,
    lines,
    errors,
  },
  null,
  2,
));
