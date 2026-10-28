import { createRef } from "./create-ref.ts";
import type { URI } from "./sigil-types.ts";
import type { MemorySpace } from "./storage/interface.ts";
import { toURI } from "./uri-utils.ts";

/**
 * The id of the space cell of `space`, the cell `Runtime.getSpaceCell()`
 * returns: the one whose cause is the space's own DID.
 */
export function spaceCellId(space: MemorySpace): URI {
  return toURI(createRef({}, space));
}

/**
 * A write refused because it lands beneath the `defaultPattern` slot of a
 * space cell that links no root yet. Such a write would land inline in the
 * space cell itself, where no root reads it and where the root's creation
 * finds the slot taken, so a space written that way never gets its root.
 */
export class SpaceRootMissingError extends Error {
  readonly #rootlessSpace: MemorySpace;

  constructor(space: MemorySpace) {
    super(
      `${space} has no root yet, so a write beneath its \`defaultPattern\` ` +
        `slot is refused rather than landing in the space cell. On a client ` +
        `runtime, when a handler's write beneath a user's own Home slot is ` +
        `refused and the refusal escapes the handler, that Home's root is ` +
        `brought up and the handler runs again. Any other space ` +
        `gets its root when an OWNER of it opens it on a client runtime, or, ` +
        `under server execution, from the space's own server once the space ` +
        `is active and its owner resolves; a user with WRITE alone does not ` +
        `bring it up by opening it.`,
    );
    this.name = "SpaceRootMissingError";
    this.#rootlessSpace = space;
  }

  /** The space whose root is missing. */
  get rootlessSpace(): MemorySpace {
    return this.#rootlessSpace;
  }
}
