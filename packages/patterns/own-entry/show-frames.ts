/**
 * Prints what one captured phase asked for and what came back, frame by
 * frame: the watch roots of each outgoing request with the selector each
 * carries, and the documents each incoming frame delivered. The frame files
 * are what `measure-start.ts` rotated out of `CF_MEMORY_FRAME_LOG`.
 *
 * Usage:
 *   deno run -A packages/patterns/own-entry/show-frames.ts \
 *     <frames.jsonl> [--selectors=<how many to print in full>]
 */

// deno-lint-ignore no-explicit-any
type Json = any;

const [path] = Deno.args.filter((arg) => !arg.startsWith("--"));
if (path === undefined) throw new Error("name a frame file");
const full = Number(
  Deno.args.find((arg) => arg.startsWith("--selectors="))?.split("=")[1] ?? "2",
);

const frames: Json[] = Deno.readTextFileSync(path).split("\n")
  .filter((line) => line.length > 0).map((line) => JSON.parse(line));

const selectors = new Map<string, Json>();
for (const frame of frames) {
  if (frame.dir === "selector") selectors.set(frame.hash, frame.selector);
}

console.log(`# ${path}`);
console.log(`# ${frames.length} frames, ${selectors.size} distinct selectors`);

const bytes = (value: number | undefined) =>
  value === undefined ? "-" : value.toLocaleString("en-US");

console.log("\n## Frames, in order\n");
for (const frame of frames) {
  if (frame.dir === "selector") continue;
  const head = `t=${String(frame.t).padStart(6)}ms ${frame.dir.padEnd(3)} ${
    String(frame.type).padEnd(20)
  } ${bytes(frame.bytes).padStart(10)} bytes`;
  if (frame.dir === "out") {
    const roots = (frame.watches ?? []).flatMap((watch: Json) =>
      watch.roots ?? []
    );
    const perSelector = new Map<string, number>();
    for (const root of roots) {
      perSelector.set(
        root.selector,
        (perSelector.get(root.selector) ?? 0) + 1,
      );
    }
    console.log(
      `${head}${
        roots.length === 0
          ? ""
          : `  roots=${roots.length} over ${perSelector.size} selectors`
      }${
        frame.commit === undefined
          ? ""
          : `  commit ops=${frame.commit.operations?.length ?? 0} reads=${
            frame.commit.confirmedReads ?? 0
          }`
      }`,
    );
    for (const [selector, count] of perSelector) {
      const text = JSON.stringify(selectors.get(selector) ?? null);
      console.log(
        `    ${String(count).padStart(4)} root(s) under selector ${selector} ` +
          `(${text.length.toLocaleString("en-US")} chars of schema)`,
      );
    }
  } else {
    const upserts = frame.sync?.upserts ?? [];
    const entities = frame.entities ?? [];
    console.log(
      `${head}${
        upserts.length === 0 ? "" : `  delivered ${upserts.length} documents`
      }${
        entities.length === 0
          ? ""
          : `  answered with ${entities.length} entities`
      }`,
    );
    for (const upsert of upserts.slice(0, 6)) {
      console.log(
        `    ${bytes(upsert.bytes).padStart(9)} bytes  ${upsert.id} ${
          upsert.scope === "space" ? "" : `(${upsert.scope}) `
        }keys=${JSON.stringify(upsert.keys).slice(0, 90)}`,
      );
    }
    if (upserts.length > 6) {
      console.log(`    … ${upserts.length - 6} more documents in this frame`);
    }
  }
}

console.log(`\n## The first ${full} selectors in full\n`);
let printed = 0;
for (const [hash, selector] of selectors) {
  if (printed++ >= full) break;
  console.log(`### ${hash}\n${JSON.stringify(selector, null, 1)}\n`);
}
