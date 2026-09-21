import type { CfcLabelView } from "@commonfabric/runner/cfc";
import { isObjectNotArray } from "@commonfabric/utils/types";

/** Matches the runtime principal only when the persisted origin has one owner. */
export function authenticatedOwnerFromLabel(
  view: CfcLabelView | undefined,
  actingPrincipal: string | undefined,
): boolean {
  if (!view || !actingPrincipal) return false;
  const subjects = new Set<string>();
  for (const entry of view.entries) {
    if (entry.path.length !== 0) continue;
    for (const atom of entry.label.integrity ?? []) {
      if (!isObjectNotArray(atom) || atom.kind !== "represents-principal") {
        continue;
      }
      if (typeof atom.subject !== "string" || !atom.subject.trim()) {
        return false;
      }
      subjects.add(atom.subject);
    }
  }
  return subjects.size === 1 && subjects.has(actingPrincipal);
}
