/** Repeated commits to a wide document with an immutable untouched subtree. */

import { toFileUrl } from "@std/path";

import { applyCommit, close, open, read } from "../v2/engine.ts";

for (const width of [256, 1184]) {
  Deno.bench({
    name: `9 updates / ${width} rows`,
    group: "cached patch replay",
    n: 5,
    warmup: 1,
    async fn(benchmark) {
      const path = await Deno.makeTempFile({ suffix: ".sqlite" });
      const engine = await open({ url: toFileUrl(path) });
      const id = "of:cached-patch-replay-bench";
      try {
        applyCommit(engine, {
          sessionId: "session:cached-patch-replay-bench",
          commit: {
            localSeq: 1,
            reads: { confirmed: [], pending: [] },
            operations: [{
              op: "set",
              id,
              value: {
                value: {
                  rows: Array.from({ length: width }, (_, index) => ({
                    index,
                    metadata: { keys: [`row-${index}`, "shared"] },
                  })),
                  count: 0,
                },
              },
            }],
          },
        });
        benchmark.start();
        for (let count = 1; count <= 9; count++) {
          applyCommit(engine, {
            sessionId: "session:cached-patch-replay-bench",
            commit: {
              localSeq: count + 1,
              reads: { confirmed: [], pending: [] },
              operations: [{
                op: "patch",
                id,
                patches: [{
                  op: "replace",
                  path: "/value/count",
                  value: count,
                }],
              }],
            },
          });
        }
        benchmark.end();
        const result = read(engine, { id })?.value as { count: number };
        if (result.count !== 9) throw new Error("patch replay lost an update");
      } finally {
        close(engine);
        await Deno.remove(path);
      }
    },
  });
}
