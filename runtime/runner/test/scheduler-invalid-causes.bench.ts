/**
 * Benchmarks for recording a scheduler node's pending invalid causes.
 *
 * `addInvalidCause` runs once per (change × triggered action) inside the
 * storage commit notification (`processStorageNotification`), synchronously
 * with the commit, so its cost is paid before the writer's transaction
 * returns. The shapes below hold the number of causes one node accumulates
 * before it runs, which is what decides whether recording them stays linear:
 * a commit that touches many paths of a document a node reads, and the same
 * causes arriving again from a retry's restoration.
 *
 * The `benchmarks.yml` workflow runs this file on main and publishes the
 * results in its `bench-results` artifact, which the team ops dashboard
 * charts on its /bench page.
 */

import type { MemorySpace } from "@commonfabric/memory/interface";

import type { IMemorySpaceAddress } from "../src/storage/interface.ts";
import {
  addInvalidCause,
  takeInvalidCauses,
} from "../src/scheduler/invalidation.ts";
import { NodeRegistry } from "../src/scheduler/node-record.ts";

const SPACE: MemorySpace =
  "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSdoom8Beere1L9DwwTm";

/** One address per path of one document, the shape a list write produces. */
function causesFor(count: number): IMemorySpaceAddress[] {
  const causes: IMemorySpaceAddress[] = [];
  for (let index = 0; index < count; index++) {
    causes.push({
      space: SPACE,
      id: "of:votes",
      type: "application/json",
      path: ["value", String(index), "castAt"],
    });
  }
  return causes;
}

for (const count of [64, 512, 2048]) {
  const causes = causesFor(count);
  const nodes = new NodeRegistry();
  const record = nodes.register(() => {}, "computation");

  Deno.bench({
    name: `record ${count} distinct causes on one node`,
    group: `invalid causes ×${count}`,
    baseline: true,
    fn: () => {
      for (const cause of causes) addInvalidCause(record, cause);
      takeInvalidCauses(record);
    },
  });

  Deno.bench({
    name: `record ${count} causes, then the same ${count} again`,
    group: `invalid causes ×${count}`,
    fn: () => {
      for (const cause of causes) addInvalidCause(record, cause);
      for (const cause of causes) addInvalidCause(record, cause);
      takeInvalidCauses(record);
    },
  });
}
