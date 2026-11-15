import type { FabricValue } from "@/interface.ts";
import { isValidFabricValue } from "@/types";
import { toCompactDebugString } from "@/value-debug";

/** How much of a rendered state to keep. */
const MAX_RENDERED_LENGTH = 200;

/**
 * Converts a state of any type at all into one that can be reported: a
 * `FabricValue` is returned as it stands, and anything else is replaced by a
 * debug rendering of itself.
 *
 * Reporting a failure must not itself fail, and a wire format's encoded states
 * need not be `FabricValue`s -- a realm-crossing format carries `ArrayBuffer`,
 * `RegExp` and `Map` natively. Carrying one of those unaltered would not
 * merely mistype it: a reported state gets deep-frozen, and `Object.freeze()`
 * throws outright on a typed array with elements.
 *
 * **A rendering is deliberately not a conversion**, though one is available.
 * `fabricFromConvertibleJsValue()` would turn a `Uint8Array` into a
 * `FabricBytes` and a `RegExp` into a `FabricRegExp`, and doing so would
 * misreport the wire: a reader would find a `FabricBytes` and conclude the
 * payload carried one, when it carried raw bytes the format does not accept. A
 * string plainly reads as a description of a value rather than the value, which
 * is the honest answer where fidelity is not on offer.
 *
 * The membership check runs guarded, so that a defect in it cannot take this
 * function down with it. That is prophylaxis against an unanticipated bug in
 * `isValidFabricValue()` rather than a guard against any particular input: this
 * runs on the failure path, where throwing does not surface a second problem
 * so much as replace the first one, the original error being lost in favor of
 * whatever the predicate did. `toCompactDebugString()` needs no such wrapping,
 * already returning `"<unrenderable debug string>"` for anything it cannot
 * render, and is the floor this rests on.
 *
 * @param state - The state at fault, of any type whatsoever.
 * @returns `state` itself, or a rendering of it.
 */
export function toReportableState(state: any): FabricValue {
  try {
    if (isValidFabricValue(state)) {
      return state;
    }
  } catch {
    // Fall through to the rendering, which is what a state this function
    // cannot classify gets anyway.
  }

  return toCompactDebugString(state, { maxLength: MAX_RENDERED_LENGTH });
}
