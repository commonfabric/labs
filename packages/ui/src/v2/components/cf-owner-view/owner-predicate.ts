import type { CfcLabelView } from "@commonfabric/runner/cfc";
import { representsPrincipalSubject } from "@commonfabric/runner/cfc/represents-principal";
import { isObjectNotArray } from "@commonfabric/utils/types";

/** Returns the unique principal attested at the persisted origin. */
export function attestedOwnerPrincipal(
  view: CfcLabelView | undefined,
): string | undefined {
  if (!view) return undefined;
  const subjects = new Set<string>();
  for (const entry of view.entries) {
    // An entry a link carries describes the document it points to.
    if (entry.path.length !== 0 || entry.observes === "followRef") continue;
    for (const atom of entry.label.integrity ?? []) {
      if (!isObjectNotArray(atom) || atom.kind !== "represents-principal") {
        continue;
      }
      const subject = representsPrincipalSubject(atom);
      if (subject === undefined) {
        return undefined;
      }
      subjects.add(subject);
    }
  }
  return subjects.size === 1 ? subjects.values().next().value : undefined;
}

/** Matches the runtime principal only when the persisted origin has one owner. */
export function authenticatedOwnerFromLabel(
  view: CfcLabelView | undefined,
  actingPrincipal: string | undefined,
): boolean {
  return !!actingPrincipal &&
    attestedOwnerPrincipal(view) === actingPrincipal;
}
