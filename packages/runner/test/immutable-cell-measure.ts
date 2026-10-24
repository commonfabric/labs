/**
 * Paired measurements of immutable array-element construction. Run with
 * `deno run -A packages/runner/test/immutable-cell-measure.ts`. Each pair
 * alternates order; fixture creation and semantic checks are outside timing.
 */
import {
  deepFreeze,
  type FabricValue,
  valueEqual,
} from "@commonfabric/data-model";
import { linkRefFrom } from "@commonfabric/data-model/cell-rep";
import { valueFromDataUri } from "@commonfabric/data-model/codec-data-uri";

import {
  dataUriSnapshotWithResolvedLinks,
  resolveImmutableValueLinks,
} from "../src/data-uri.ts";
import { ImmutableCellStore } from "../src/immutable-cell.ts";
import { createSigilLinkFromParsedLink } from "../src/link-utils.ts";
import type { NormalizedLink } from "../src/link-types.ts";

const base: NormalizedLink = {
  id: "of:benchmark-origin",
  space: "did:key:benchmark",
  path: ["rows", "0"],
  scope: "space",
};
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const results = [];
for (const schemaShape of ["inline", "reference"]) {
  for (const size of [100, 1000]) {
    const makeValue = () => {
      const schema = {
        type: "object" as const,
        properties: Object.fromEntries(
          Array.from(
            { length: 30 },
            (
              _,
              i,
            ) => [`field${i}`, {
              type: "string" as const,
              description: `Schema field ${i}`,
            }],
          ),
        ),
      };
      return {
        rows: Array.from({ length: size }, (_, index) => ({
          index,
          title: `row ${index}: café 🌍`,
          values: [undefined, -0, Infinity],
          target: schemaShape === "inline"
            ? linkRefFrom({ path: ["targets", String(index)], schema })
            : createSigilLinkFromParsedLink({
              path: ["targets", String(index)],
              schema,
            }, { includeSchema: true }),
        })),
      };
    };
    for (const mode of ["fresh frozen", "fresh mutable", "reused frozen"]) {
      const store = new ImmutableCellStore();
      const shared = deepFreeze(makeValue());
      const legacy = dataUriSnapshotWithResolvedLinks(shared, base);
      const snapshot = store.createElement(shared, base);
      if (
        !valueEqual(
          valueFromDataUri(legacy.id),
          resolveImmutableValueLinks(snapshot.value, snapshot.id),
        )
      ) {
        throw new Error("Snapshot contents differ");
      }
      if (snapshot.value !== shared) throw new Error("Frozen graph copied");
      const iterations = mode === "reused frozen" ? 10 : 1;
      const samples: { legacyMs: number; nativeMs: number }[] = [];
      const measuredSharing = new Set<boolean>();
      for (let round = 0; round < 9; round++) {
        const inputs: FabricValue[] = Array.from(
          { length: 2 },
          () =>
            mode === "reused frozen"
              ? shared
              : mode === "fresh frozen"
              ? deepFreeze(makeValue())
              : makeValue(),
        );
        const pair = { legacyMs: 0, nativeMs: 0 };
        for (
          const arm of round % 2 === 0
            ? ["legacy", "native"]
            : ["native", "legacy"]
        ) {
          const value = inputs[arm === "legacy" ? 0 : 1];
          let measuredSnapshot;
          const start = performance.now();
          for (let i = 0; i < iterations; i++) {
            if (arm === "legacy") dataUriSnapshotWithResolvedLinks(value, base);
            else measuredSnapshot = store.createElement(value, base);
          }
          const elapsed = (performance.now() - start) / iterations;
          if (measuredSnapshot !== undefined) {
            measuredSharing.add(measuredSnapshot.value === value);
          }
          if (arm === "legacy") pair.legacyMs = elapsed;
          else pair.nativeMs = elapsed;
        }
        // Two warm-up pairs are excluded, but both arms run in each pair.
        if (round >= 2) samples.push(pair);
      }
      results.push({
        size,
        schemaShape,
        mode,
        iterations,
        legacyIdChars: legacy.id.length,
        nativeIdChars: snapshot.id.length,
        sharesMeasuredInput: [...measuredSharing],
        legacyMedianMs: median(samples.map((s) => s.legacyMs)),
        nativeMedianMs: median(samples.map((s) => s.nativeMs)),
        samples,
      });
      store.dispose();
    }
  }
}
console.log(
  JSON.stringify({ runtime: Deno.version, host: Deno.build, results }, null, 2),
);
