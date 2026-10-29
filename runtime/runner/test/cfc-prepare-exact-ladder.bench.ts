/** Measures preparation with exactly R journal reads and P raw container writes. */

import { preparedDigestFor } from "../src/cfc/canonical.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";
import { prepareLadderFixture } from "./cfc-prepare-ladder-fixture.ts";

const fixtures: Awaited<ReturnType<typeof prepareLadderFixture>>[] = [];
for (const entries of [100, 300, 1000]) {
  const fixture = await prepareLadderFixture(entries);
  fixtures.push(fixture);
  for (const reads of [50, 200, 800]) {
    for (const paths of [8, 50, 200]) {
      for (const phase of ["prepare", "flow", "digest"] as const) {
        let reported = false;
        Deno.bench({
          name: `exact R=${reads} P=${paths} E=${entries} ${phase}`,
          group: "commit preparation",
          n: 5,
          warmup: 2,
          fn(b) {
            const tx = fixture.make(reads, paths, true);
            try {
              const actualReads = [...tx.getReadActivities()].length;
              if (actualReads !== reads) {
                throw new Error(`Expected ${reads} reads, got ${actualReads}`);
              }
              const digestInput = phase === "digest"
                ? tx.accessForTestingOnly.buildPreparedDigestInput()
                : undefined;
              b.start();
              if (phase === "prepare") fixture.runtime.prepareTxForCommit(tx);
              else if (phase === "flow") deriveFlowJoin(tx);
              else preparedDigestFor(digestInput!);
              b.end();
              if (
                phase === "prepare" &&
                tx.getCfcState().prepare.status !== "prepared"
              ) {
                throw new Error(JSON.stringify(tx.getCfcState().prepare));
              }
              if (!reported) {
                benchDiagnostic(
                  JSON.stringify({
                    reads,
                    paths,
                    entries,
                    phase,
                    actualReads,
                    stats: fixture.runtime.getCfcStats(),
                  }),
                );
                reported = true;
              }
            } finally {
              tx.abort();
            }
          },
        });
      }
    }
  }
}
globalThis.addEventListener("unload", () => {
  void Promise.all(fixtures.map((fixture) => fixture.dispose()));
});
