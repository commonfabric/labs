/**
 * Marks a run of an action on a run beacon, lets the action go, and has the
 * garbage collector collect it, then prints as JSON the numbers the beacon
 * posted as named and as forgotten. `run-beacon.test.ts` runs it, since
 * collecting needs `--expose-gc`, which the package's test task does not give.
 */

import {
  newRunBeaconBuffer,
  RunBeacon,
} from "../../src/executor/run-beacon.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";

const named: number[] = [];
const forgotten = Promise.withResolvers<readonly number[]>();
const marks = new RunBeacon(
  newRunBeaconBuffer(),
  (identity) => named.push(identity.run),
  (runs) => forgotten.resolve(runs),
).forSpace("did:key:z6MkRunBeaconCollection" as MemorySpace);
(() => marks.hold(() => {}, "collected", () => {}))();
(globalThis as unknown as { gc(): void }).gc();
console.log(JSON.stringify({ named, forgotten: await forgotten.promise }));
