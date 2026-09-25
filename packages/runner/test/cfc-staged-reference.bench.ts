/** Measures preparation of shared reference graphs and ordinary chains. */
import { Identity } from "@commonfabric/identity";

import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  seedReferenceGraphLeaf,
  stageReferenceGraph,
} from "./support/staged-reference-graph.ts";

const signer = await Identity.fromPassphrase("staged-reference-bench");
const space = signer.did();
const runtime = new Runtime({
  apiUrl: new URL("https://example.com"),
  storageManager: StorageManager.emulate({ as: signer }),
});
await seedReferenceGraphLeaf(runtime, space);

for (const depth of [4, 8, 10]) {
  for (const width of [1, 2]) {
    for (const order of ["bottom-up", "top-down"] as const) {
      Deno.bench({
        name: `depth=${depth} width=${width} ${order}`,
        group: "staged reference preparation",
        fn(timer) {
          const { tx, holder } = stageReferenceGraph(
            runtime,
            space,
            depth,
            width,
            order,
          );
          try {
            timer.start();
            runtime.prepareTxForCommit(tx);
            timer.end();
            const entries =
              readStoredCfcMetadata(tx, holder.getAsNormalizedFullLink())!
                .labelMap.entries;
            const leaves = entries.filter((entry) =>
              entry.path.length === depth + 1 &&
              entry.label.confidentiality?.includes("secret")
            );
            if (leaves.length !== width ** depth) {
              throw new Error(
                "Reference graph is missing confidential leaf labels",
              );
            }
          } finally {
            tx.abort();
          }
        },
      });
    }
  }
}

globalThis.addEventListener("unload", () => void runtime.dispose());
