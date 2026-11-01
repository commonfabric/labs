import { isObjectOrArray } from "@commonfabric/js-values/types";

import type { NormalizedFullLink } from "../link-types.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  isCurrentPrincipalPlaceholder,
  loadStoredCfcEnvelope,
} from "./prepare.ts";
import { representsPrincipalSubject } from "./represents-principal.ts";
import { cfcSchemaEntries } from "./schema-label-view.ts";

/**
 * The creator a piece created before the runtime recorded one gives evidence
 * of: the one principal the stored labels of its owner-protected fields
 * represent.
 *
 * A field whose schema declares a placeholder `ownerPrincipal` is bound to
 * the principal its stored label represents, by the setup that created the
 * piece on their behalf or by the first write through its writer. Where every
 * such field across `documents`, the piece's argument and internal documents,
 * names the same principal, that principal is recorded as the piece's creator
 * at its next source transition, so the field the transition installs binds
 * them (`docs/plans/piece-creator-owns-update-added-fields.md`). A piece whose
 * fields name two principals, or none, offers no evidence and stays without a
 * record; so does one whose stored envelope this build cannot read.
 */
// SPEC-PENDING https://github.com/commonfabric/specs/pull/87
export const legacyPieceCreatorEvidence = (
  tx: IExtendedStorageTransaction,
  documents: readonly NormalizedFullLink[],
): string | undefined => {
  const owners = new Set<string>();
  for (const document of documents) {
    const envelope = loadStoredCfcEnvelope(tx, document);
    if (envelope.status === "unreadable") return undefined;
    if (envelope.status !== "loaded") continue;
    const ownerPaths = cfcSchemaEntries(envelope.schema)
      .filter((entry) =>
        isObjectOrArray(entry.schema) && isObjectOrArray(entry.schema.ifc) &&
        isCurrentPrincipalPlaceholder(entry.schema.ifc.ownerPrincipal)
      )
      .map((entry) => entry.path);
    for (const entry of envelope.metadata.labelMap.entries) {
      if (entry.origin !== undefined && entry.origin !== "declared") continue;
      const atOwnerPosition = ownerPaths.some((path) =>
        path.length === entry.path.length &&
        path.every((part, index) => part === "*" || part === entry.path[index])
      );
      if (!atOwnerPosition) continue;
      for (const atom of entry.label.integrity ?? []) {
        const subject = representsPrincipalSubject(atom);
        if (subject !== undefined) owners.add(subject);
      }
    }
  }
  return owners.size === 1 ? [...owners][0] : undefined;
};
