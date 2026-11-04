/** Admission of paths through a piece's current input projection. */

import {
  type Cell,
  type CellPath,
  schemaPathSelection,
} from "@commonfabric/runner";

/** A path that the current pattern cannot observe through its input schema. */
export class PieceInputPathError extends Error {
  override readonly name = "PieceInputPathError";

  constructor(path: CellPath) {
    super(
      `Cannot access path "${path.join("/")}" - property "${
        String(path.at(-1))
      }" ` +
        "not found in the current pattern's input schema. " +
        "Update the target pattern with cf piece setsrc to " +
        "declare this input before linking, reading, or writing it. " +
        "--allow-non-existing does not override the input schema.",
    );
  }
}

/** Refuses paths a piece cannot observe, before narrowing loses that evidence. */
export function assertPieceInputPath(
  cell: Cell<unknown>,
  path: CellPath,
  options: { allowArrayLength?: boolean } = {},
): void {
  // Link serialization omits the permissive schemas `true` and `{}`, including
  // for persisted open-input patterns. An absent link schema must therefore
  // remain permissive; setup and source updates retain constrained schemas.
  if (
    !schemaPathSelection(cell.getAsNormalizedFullLink().schema, path, options)
      .selected
  ) {
    throw new PieceInputPathError(path);
  }
}
