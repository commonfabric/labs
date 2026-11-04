import { assert, assertEquals } from "@std/assert";
import { resolve } from "@std/path";
import type { PatternCoverageSpan } from "@commonfabric/runner";
import {
  collectPatternCoverage,
  PATTERNS_ROOT,
  withRepositoryFileNames,
} from "./pattern-coverage.ts";
import type { Page } from "./page.ts";

const span = (fileName: string): PatternCoverageSpan => ({
  fileName,
  id: 1,
  kind: "runtime",
  startLine: 1,
  endLine: 1,
  startColumn: 1,
  endColumn: 2,
});

//
// A worker reports two shapes of file name, depending on how the pattern reached
// it, and the gate only credits a line if its `SF:` path matches the file the
// source walk found. So resolve each shape the way the LCOV writer will and
// check it lands on a file that actually exists — a mapping that is merely
// plausible produces a path nothing matches, and the coverage silently
// evaporates rather than failing anything.
//

Deno.test("worker span file names resolve onto real pattern files", async () => {
  const cases = [
    {
      label: "fetched over HTTP, named by URL pathname",
      reported: "/api/patterns/system/default-app/default-app.tsx",
      expected: "/system/default-app/default-app.tsx",
      file: "system/default-app/default-app.tsx",
    },
    {
      label: "resolved from disk, named relative to the patterns root",
      reported: "/apps/lunch-poll/main.tsx",
      expected: "/apps/lunch-poll/main.tsx",
      file: "apps/lunch-poll/main.tsx",
    },
  ];

  for (const { label, reported, expected, file } of cases) {
    const mapped = withRepositoryFileNames({
      spans: [span(reported)],
      hits: [{ fileName: reported, id: 1, count: 1 }],
    });
    assertEquals(mapped.spans[0].fileName, expected, label);
    // The hits must be renamed with the spans; a hit left under the old name
    // would key against nothing and report the line uncovered.
    assertEquals(mapped.hits[0].fileName, expected, label);

    // This is what `writePatternCoverageLcov({ root: PATTERNS_ROOT })` emits.
    const sourcePath = resolve(
      PATTERNS_ROOT,
      mapped.spans[0].fileName.slice(1),
    );
    assertEquals(sourcePath, resolve(PATTERNS_ROOT, file), label);
    assert(
      (await Deno.stat(sourcePath)).isFile,
      `${label}: ${sourcePath} is not a file in this checkout`,
    );
  }
});

Deno.test("a name that is not under the patterns route is left alone", () => {
  // Fabric mounts carry their own identity-based path and are reported as-is.
  const mounted = "/~cf/abc123/main.tsx";
  const mapped = withRepositoryFileNames({
    spans: [span(mounted)],
    hits: [{ fileName: mounted, id: 1, count: 1 }],
  });
  assertEquals(mapped.spans[0].fileName, mounted);
});

//
// Collecting one page's dump
//
// The dump is the only chance to take what a worker holds: the runtime it
// belongs to is dropped immediately afterwards, and every hit it accumulated
// goes with it. A page that never booted a runtime is the one empty-handed
// answer that costs nothing. Every other one is coverage the report will not
// carry, which the gate reads as lines that ran nowhere, so the cases below
// pin that each of those says so.
//

// A `Page` that answers `evaluate` with `respond()`, ignoring the function it
// is handed. The real evaluate runs that function in the page's realm; here the
// answer stands for what the realm would have returned.
function respondingPage(respond: () => unknown): Page {
  return {
    evaluate: () => Promise.resolve(respond()),
  } as unknown as Page;
}

// Runs `body` with pattern coverage written to a temporary directory, and with
// every `console.warn` collected rather than printed. Returns what was warned.
async function collectingWarnings(
  body: (dir: string) => Promise<void>,
): Promise<string[]> {
  const dir = await Deno.makeTempDir();
  const previousDir = Deno.env.get("CF_PATTERN_COVERAGE_DIR");
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  Deno.env.set("CF_PATTERN_COVERAGE_DIR", dir);
  try {
    await body(dir);
  } finally {
    console.warn = warn;
    if (previousDir === undefined) Deno.env.delete("CF_PATTERN_COVERAGE_DIR");
    else Deno.env.set("CF_PATTERN_COVERAGE_DIR", previousDir);
    await Deno.remove(dir, { recursive: true });
  }
  return warnings;
}

// The `DA:` counts the merged LCOV in `dir` carries for `path`.
async function lcovCounts(
  dir: string,
  path: string,
): Promise<Map<number, number>> {
  const [entry] = [...Deno.readDirSync(dir)];
  const text = await Deno.readTextFile(resolve(dir, entry.name));
  const counts = new Map<number, number>();
  let inRecord = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) inRecord = line.slice(3).endsWith(path);
    else if (inRecord && line.startsWith("DA:")) {
      const [number, count] = line.slice(3).split(",");
      counts.set(Number(number), Number(count));
    }
  }
  return counts;
}

Deno.test("a dump carrying only hits credits the lines they name", async () => {
  // The realm that compiled a pattern holds its spans; a realm that warm-loaded
  // the same instrumented bytes reports hits against them and holds none. The
  // second dump is the whole contribution of every page that ran a pattern
  // somebody else compiled.
  const fileName = "/api/patterns/system/profile-home/profile-home.tsx";
  const compiled = span(fileName);
  const warnings = await collectingWarnings(async (dir) => {
    await collectPatternCoverage(
      respondingPage(() => ({ data: { spans: [compiled], hits: [] } })),
    );
    assertEquals(
      (await lcovCounts(dir, "system/profile-home/profile-home.tsx")).get(1),
      0,
      "the compiling realm ran no line of it",
    );

    await collectPatternCoverage(
      respondingPage(() => ({
        data: { spans: [], hits: [{ fileName, id: compiled.id, count: 1 }] },
      })),
    );
    assertEquals(
      (await lcovCounts(dir, "system/profile-home/profile-home.tsx")).get(1),
      1,
      "the warm-loading realm's hit lands on the compiling realm's span",
    );
  });
  assertEquals(warnings, []);
});

Deno.test("a page that never booted a runtime is collected in silence", async () => {
  const warnings = await collectingWarnings(async () => {
    await collectPatternCoverage(respondingPage(() => ({ noRuntime: true })));
  });
  assertEquals(warnings, []);
});

Deno.test("a page that cannot be reached reports what it took with it", async () => {
  const warnings = await collectingWarnings(async () => {
    await collectPatternCoverage(respondingPage(() => {
      throw new Error("Page is already closed.");
    }));
  });
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("Page is already closed."), warnings[0]);
});

Deno.test("a runtime that does not answer the request reports the loss", async () => {
  const warnings = await collectingWarnings(async () => {
    await collectPatternCoverage(
      respondingPage(() => ({ noCoverageRequest: true })),
    );
  });
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("getPatternCoverage"), warnings[0]);
});

Deno.test("a worker built without a collector reports the loss", async () => {
  const warnings = await collectingWarnings(async () => {
    await collectPatternCoverage(respondingPage(() => ({ data: null })));
  });
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("without a collector"), warnings[0]);
});

Deno.test("a second runtime's dump adds to the first rather than replacing it", async () => {
  // One page runs several runtimes, because the shell builds a new one for
  // every navigation and every identity set on it, and each is pulled from
  // before it goes. What the second hands over joins what the first did.
  const fileName = "/api/patterns/system/profile-create/profile-create.tsx";
  const compiled = { ...span(fileName), id: 2 };
  const warnings = await collectingWarnings(async (dir) => {
    await collectPatternCoverage(
      respondingPage(() => ({
        data: { spans: [compiled], hits: [{ fileName, id: 2, count: 1 }] },
      })),
    );
    assertEquals(
      (await lcovCounts(dir, "system/profile-create/profile-create.tsx")).get(
        1,
      ),
      1,
      "the first runtime's hit",
    );

    await collectPatternCoverage(
      respondingPage(() => ({
        data: { spans: [compiled], hits: [{ fileName, id: 2, count: 1 }] },
      })),
    );
    assertEquals(
      (await lcovCounts(dir, "system/profile-create/profile-create.tsx")).get(
        1,
      ),
      2,
      "both runtimes' hits, added rather than the second standing alone",
    );
  });
  assertEquals(warnings, []);
});

Deno.test("a later dump leaves an earlier dump's record standing", async () => {
  // Each dump rewrites the whole merged report, which is what lets the file on
  // disk stand complete at every moment without a process-exit hook. A dump
  // that names one pattern carries every earlier pattern out with it.
  const first = "/api/patterns/system/piece-grid/piece-grid.tsx";
  const second = "/api/patterns/system/backlinks-index/backlinks-index.tsx";
  const dumpOf = (fileName: string, id: number) => ({
    data: {
      spans: [{ ...span(fileName), id }],
      hits: [{ fileName, id, count: 1 }],
    },
  });
  const warnings = await collectingWarnings(async (dir) => {
    await collectPatternCoverage(respondingPage(() => dumpOf(first, 3)));
    await collectPatternCoverage(respondingPage(() => dumpOf(second, 4)));
    assertEquals(
      (await lcovCounts(dir, "system/piece-grid/piece-grid.tsx")).get(1),
      1,
      "the first dump's record survived the second dump's rewrite",
    );
    assertEquals(
      (await lcovCounts(dir, "system/backlinks-index/backlinks-index.tsx")).get(
        1,
      ),
      1,
      "the second dump's own record",
    );
  });
  assertEquals(warnings, []);
});
