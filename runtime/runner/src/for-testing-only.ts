/**
 * What this package offers to tests alone.
 *
 * This has its own entry in the package's export map and no place in any
 * barrel, so that nothing outside a test reaches it by accident.
 */

import { deepFreeze } from "@commonfabric/data-model";
// @ts-types="@types/ws"
import { WebSocket } from "ws";

import { instancePartialCause } from "./builder/instance-name.ts";
import { freezePartialCauses } from "./builder/pattern.ts";
import type { JSONObject, Pattern } from "./builder/types.ts";

/**
 * The `ws` class behind every memory socket a runtime opens under Deno, for a
 * test that shapes memory traffic by patching its prototype. A patch reaches
 * only the realm that makes it, since each worker loads its own copy. A test
 * resolving `ws` through another package's import map could load a separate
 * copy, whose prototype no memory socket uses.
 */
export const MemoryWebSocketForTestingOnly = WebSocket;

/**
 * Returns `pattern`, a pattern a test writes out as an object literal rather
 * than building with the builder, with its partial causes deep-frozen in place
 * the way the builder freezes those of every pattern it builds. The runtime
 * refuses a partial cause that is an object but not deep-frozen, so a literal
 * whose manifest or `$alias` bindings carry an object cause runs only once it
 * has been through here.
 */
export function patternLiteralForTestingOnly<T extends Pattern>(
  pattern: T,
): T {
  freezePartialCauses(pattern);
  return pattern;
}

/**
 * The partial cause, deep-frozen, of the sub-pattern instance a pattern binds
 * to the `const` named `name`, under which its parent holds that instance's
 * child. The builder makes it inside a pattern and no public export names it,
 * so a test that reads a named instance's child from outside the pattern finds
 * the child's spot through here.
 */
export function instancePartialCauseForTestingOnly(name: string): JSONObject {
  return deepFreeze(instancePartialCause(name));
}
