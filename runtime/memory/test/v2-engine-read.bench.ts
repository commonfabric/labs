/**
 * Current-state reads of documents whose decoded revisions the engine already
 * caches, so what a read costs past the cache lookup is resolving its branch
 * and finding the revision row. One fixture serves every case: 256 documents
 * written in one commit, a fork taken there, and a second commit on the
 * default branch that rewrites all of them, so a fork read finds nothing of
 * its own and reads its parent as of the fork point. Each body reads every
 * document once; the fixture, and checking what the reads returned, stay
 * outside the timed interval.
 */

import { toFileUrl } from "@std/path";

import { applyCommit, close, createBranch, open, read } from "../v2/engine.ts";

const COUNT = 256;
const ids = Array.from(
  { length: COUNT },
  (_, index) => `of:engine-read-${index}`,
);

const path = await Deno.makeTempFile({ suffix: ".sqlite" });
const engine = await open({ url: toFileUrl(path) });
globalThis.addEventListener("unload", () => {
  close(engine);
  Deno.removeSync(path);
});

const setAll = (localSeq: number, generation: string) =>
  applyCommit(engine, {
    sessionId: "session:engine-read-bench",
    commit: {
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: ids.map((id, index) => ({
        op: "set" as const,
        id,
        value: { value: { index, generation } },
      })),
    },
  });

setAll(1, "forked");
createBranch(engine, "fork");
setAll(2, "current");

/** Reads every document on `branch`, and throws unless each is `generation`. */
const readAll = (
  benchmark: Deno.BenchContext,
  branch: string | undefined,
  generation: string,
): void => {
  const values: unknown[] = new Array(COUNT);
  benchmark.start();
  for (let index = 0; index < COUNT; index++) {
    values[index] = read(engine, {
      id: ids[index],
      ...(branch === undefined ? {} : { branch }),
    })?.value;
  }
  benchmark.end();
  for (const [index, value] of values.entries()) {
    const { generation: found } = value as { generation: string };
    if (found !== generation) {
      throw new Error(`document ${index} read ${found}, not ${generation}`);
    }
  }
};

Deno.bench({
  name: `${COUNT} docs at head`,
  group: "engine read",
  fn: (benchmark) => readAll(benchmark, undefined, "current"),
});

Deno.bench({
  name: `${COUNT} docs on a fork`,
  group: "engine read",
  fn: (benchmark) => readAll(benchmark, "fork", "forked"),
});
