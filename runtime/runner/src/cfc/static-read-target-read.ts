/**
 * The read metadata of `#collectStaticReadTargetsWithCompleteness()` in
 * `runner.ts`.
 */

import type { Metadata } from "../storage/interface.ts";
import {
  machineryRead,
  schedulerDependencyRead,
} from "../storage/reactivity-log.ts";

/**
 * The metadata of the reads that resolve a new action's declared inputs to
 * certify its static read set. They are runtime wiring (`machineryRead`) and
 * dependency discovery (`schedulerDependencyRead`, which dependency seeding
 * carries alone), and the scheduler marker decides what they consume: the
 * flow join and the runtime read ceiling skip them, while conflict detection
 * and the consumed set the input gate, egress and sinks check keep them.
 * Inside the committing transaction a setup runs in, that exclusion is the
 * §18.6.2 class specs#100 proposes. One frozen object, so the reads share the
 * transaction's resolution memo, which is keyed by it.
 */
// SPEC-PENDING https://github.com/commonfabric/specs/pull/100
export const STATIC_READ_TARGET_READ: Metadata = Object.freeze({
  ...machineryRead,
  ...schedulerDependencyRead,
});
