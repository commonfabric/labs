/**
 * Measures `collectMaterializerWritersForLog()` over one large log whose reads
 * all land on the entity several materializers write, each materializer
 * overlapping only a read near the end of the log.
 */

import { expect } from "@std/expect";

import {
  collectMaterializerWritersForLog,
  SchedulerMaterializers,
} from "../src/scheduler/materializers.ts";
import type { Action, ReactivityLog } from "../src/scheduler/types.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";

const MATERIALIZER_COUNT = 8;

function address(...path: string[]): IMemorySpaceAddress {
  return {
    space: "did:key:z6Mk-materializer-writers-bench",
    scope: "space",
    id: "of:votes",
    path,
  };
}

for (const readCount of [100, 1000, 3500]) {
  const index = new SchedulerMaterializers(new Set(), () => ({
    principal: "did:key:z6Mk-materializer-writers-bench",
    sessionId: "bench",
  }));
  for (let m = 0; m < MATERIALIZER_COUNT; m++) {
    const materializer: Action = () => {};
    index.registerAddresses(materializer, [
      address("votes", String(readCount - 1 - m)),
    ]);
  }
  const log: ReactivityLog = {
    reads: Array.from(
      { length: readCount },
      (_, i) => address("votes", String(i), "choice"),
    ),
    shallowReads: [],
    writes: [],
  };

  Deno.bench({
    name: `${readCount} reads, ${MATERIALIZER_COUNT} materializers`,
    group: "materializer writers for log",
    fn(b) {
      b.start();
      const writers = collectMaterializerWritersForLog(index, log);
      b.end();
      expect(writers.size).toBe(MATERIALIZER_COUNT);
    },
  });
}
