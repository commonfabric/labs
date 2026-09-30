/** Measures prepared-digest work over frozen transaction records. */
import { getFrozenObjectHashCacheHitsForTestingOnly } from "@commonfabric/data-model/for-testing-only";
import { Identity } from "@commonfabric/identity";

import { preparedDigestFor } from "../src/cfc/canonical.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import { benchDiagnostic } from "./bench-diagnostics.ts";

const signer = await Identity.fromPassphrase("cfc-prepared-digest-bench");
const storageManager = StorageManager.emulate({ as: signer });
const runtime = new Runtime({
  apiUrl: new URL("https://example.com"),
  storageManager,
});

/** Records a payload and its policy material at a distinct address. */
function write(tx: ExtendedStorageTransaction, index: number, bytes: number) {
  const target = {
    space: signer.did(),
    scope: "space" as const,
    id: `of:digest-${index}` as const,
    path: [],
  };
  const value = { text: "x".repeat(bytes), index };
  tx.writeValueOrThrow(target, value);
  tx.recordCfcWritePolicyInput({
    kind: "custom",
    name: `payload-${index}`,
    target,
    value: { value, schema: { type: "object" } },
  });
  return target;
}

for (const writes of [5, 50, 200]) {
  for (const bytes of [1024, 10240]) {
    for (
      const phase of [
        "first",
        "unchanged",
        "one-write",
        "warm-parts",
        "prepare-and-recheck",
      ]
    ) {
      let reported = false;
      Deno.bench({
        name: `${writes} writes / ${bytes / 1024} KiB / ${phase}`,
        group: "prepared digest",
        fn(b) {
          const tx = runtime.edit() as ExtendedStorageTransaction;
          try {
            const targets = Array.from(
              { length: writes },
              (_, index) => write(tx, index, bytes),
            );
            for (let index = 0; index < 300; index++) {
              const target = targets[index % writes];
              tx.readValueOrThrow(target);
              tx.recordCfcDereferenceTrace({
                source: { ...target, path: ["links", String(index)] },
                target,
                kind: "value",
              });
            }
            const access = tx.accessForTestingOnly;
            const input = phase === "warm-parts"
              ? access.buildPreparedDigestInput()
              : undefined;
            const first = phase === "first" || phase === "prepare-and-recheck"
              ? undefined
              : input === undefined
              ? access.preparedDigest()
              : preparedDigestFor(input);
            if (phase === "one-write") write(tx, writes, bytes);
            const hitsBefore = getFrozenObjectHashCacheHitsForTestingOnly();
            let recheck: string | undefined;
            b.start();
            const digest = input === undefined
              ? access.preparedDigest()
              : preparedDigestFor({ ...input });
            if (phase === "prepare-and-recheck") {
              recheck = access.preparedDigest();
            }
            b.end();
            if (recheck !== undefined && recheck !== digest) {
              throw new Error("Recheck changed the digest");
            }
            const hits = getFrozenObjectHashCacheHitsForTestingOnly() -
              hitsBefore;
            if (!digest || (phase === "one-write" && digest === first)) {
              throw new Error("Digest did not bind the added write");
            }
            if (
              (phase === "unchanged" || phase === "warm-parts") &&
              digest !== first
            ) throw new Error("Unchanged activity changed the digest");
            if (!reported) {
              benchDiagnostic(JSON.stringify({ writes, bytes, phase, hits }));
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
