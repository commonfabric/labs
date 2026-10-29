import { handler, NAME, Writable } from "commonfabric";
import { MentionablePiece } from "../backlinks-index/backlinks-index.tsx";

/**
 * Parse a path like "PieceName/result/field" or "PieceName/input/field"
 */
function parsePath(path: string): {
  pieceName: string;
  cellType?: "result" | "input";
  path: (string | number)[];
} {
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    throw new Error(`Invalid path: "${path}"`);
  }

  const pieceName = segments[0];
  const rest = segments.slice(1);

  // Check if second segment is "result" or "input"
  if (rest.length > 0 && (rest[0] === "result" || rest[0] === "input")) {
    return {
      pieceName,
      cellType: rest[0],
      path: rest.slice(1),
    };
  }

  return { pieceName, path: rest };
}

/**
 * Find a piece by name from the mentionable list
 */
function findPieceByName(
  mentionable: Writable<MentionablePiece[]>,
  name: string,
): Writable<MentionablePiece> | undefined {
  for (let i = 0; i < mentionable.get().length; i++) {
    const c = mentionable.key(i);
    if (c.get()[NAME] === name) {
      return c;
    }
  }

  return undefined;
}

/**
 * Navigate through a path of keys/indices on a cell
 */
function navigateToCell(
  cell: Writable<any>,
  path: readonly (string | number)[],
): Writable<any> {
  let current = cell;
  for (const segment of path) {
    current = current.key(segment);
  }
  return current;
}

/**
 * Handler for creating links between piece cells.
 * Used by chatbot.tsx to enable LLM-driven cell linking.
 *
 * Supports paths like:
 *   - "PieceName/result/field" - link from piece result
 *   - "PieceName/input/field"  - link to/from piece input
 *   - "PieceName/field"        - defaults to result
 */
export const linkTool = handler<
  { source: string; target: string },
  { mentionable: Writable<MentionablePiece[]> }
>(({ source, target }, { mentionable }) => {
  const sourceParsed = parsePath(source);
  const targetParsed = parsePath(target);

  // Find source and target pieces
  const sourcePiece = findPieceByName(mentionable, sourceParsed.pieceName);
  if (!sourcePiece) {
    const names = mentionable
      .map((c) => c[NAME])
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Source piece "${sourceParsed.pieceName}" not found. Available: ${
        names || "none"
      }`,
    );
  }

  const targetPiece = findPieceByName(mentionable, targetParsed.pieceName);
  if (!targetPiece) {
    const names = mentionable
      .map((c) => c[NAME])
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Target piece "${targetParsed.pieceName}" not found. Available: ${
        names || "none"
      }`,
    );
  }

  // Navigate to source cell
  let sourceCell: Writable<any> = sourcePiece;
  if (sourceParsed.cellType === "input") {
    const argCell = sourcePiece.resolveAsCell().getArgumentCell();
    if (!argCell) throw new Error("Source piece has no argument cell");
    sourceCell = argCell;
  }
  sourceCell = navigateToCell(sourceCell, sourceParsed.path);

  // Navigate to target cell
  let targetCell: Writable<any> = targetPiece;
  if (targetParsed.cellType === "input" || targetParsed.path.length > 0) {
    // For any path or explicit "input", navigate to argument cell
    const argCell = targetPiece.resolveAsCell().getArgumentCell();
    if (!argCell) throw new Error("Target piece has no argument cell");
    targetCell = argCell;
  }

  // Pop last segment as the key to set
  const targetPath = [...targetParsed.path];
  const targetKey = targetPath.pop();
  if (targetKey === undefined) {
    throw new Error("Target path cannot be empty");
  }

  // Navigate to parent and set link
  const targetParent = navigateToCell(targetCell, targetPath);
  targetParent.key(targetKey).set(sourceCell);
});
