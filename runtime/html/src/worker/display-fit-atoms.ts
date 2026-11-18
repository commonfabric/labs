/**
 * The part of a display's fit decided from the labels alone (CFC §8.10.6): a
 * ceiling, the atoms it admits, and the fit of a display that no authored policy
 * covers. It consults no exchange rule, membership, or module policy, which is
 * what `display-fit.ts` adds and what makes that module read cells and the
 * runtime. A reader outside the runtime that shows a stored value decides by
 * this code without loading those.
 */

import { CFC_ATOM_TYPE, type CfcAtom } from "@commonfabric/api/cfc";
import { uniqueCfcAtoms } from "@commonfabric/memory/v2/cfc-clause-identity";
import type {
  CfcConfClause,
  CfcLabelView,
  IFCLabel,
} from "@commonfabric/runner/cfc";
import { defaultDisplayCeiling } from "@commonfabric/runner/cfc/default-display-ceiling";
import { CFC_LABEL_READ_FAILED_ATOM } from "@commonfabric/runner/cfc/observation";
import { readConsumesEntry } from "@commonfabric/runner/cfc/observation-classes";
import { deepEqual } from "@commonfabric/js-values/deep-equal";
import { isObjectOrArray } from "@commonfabric/js-values/types";

import {
  normalizeRenderConfidentialityCeiling,
  type RenderPolicy,
} from "./types.ts";

/**
 * The policy a display decision starts from at the root, before any authored
 * boundary narrows it: the host's default ceiling when one is configured
 * (spec §8.10.6), or `undefined` for none, when nothing is gated. A malformed
 * ceiling reads as the empty one, which admits public content only, rather
 * than as none.
 */
export function rootRenderPolicyFor(
  configured: unknown,
): RenderPolicy | undefined {
  const ceiling = normalizeRenderConfidentialityCeiling(configured);
  return ceiling === undefined ? undefined : {
    declassifyConfidentiality: [],
    maxConfidentiality: [...(ceiling.atoms ?? [])],
    caveatKindAllow: [...(ceiling.caveatKinds ?? [])],
  };
}

/**
 * Per-atom admission under a render policy. The read-failure marker is
 * ungrantable: it means "the label could not be read", so neither author
 * declassification nor a ceiling entry, even one naming the exported marker
 * string, may admit it. Every other atom checks declassification first, then
 * the ceiling.
 */
export function atomRenderableUnderPolicy(
  atom: unknown,
  policy: RenderPolicy,
): boolean {
  if (deepEqual(atom, CFC_LABEL_READ_FAILED_ATOM)) {
    return false;
  }
  if (
    policy.declassifyConfidentiality.some((declassified) =>
      deepEqual(declassified, atom)
    )
  ) {
    return true;
  }
  return canRenderConfidentialityAtom(atom, policy);
}

/**
 * Whether `atom` sits under `policy`'s ceiling: listed in it, or a caveat of a
 * kind the policy's caveat-kind allowance admits (spec §8.10.6). Admission is
 * not discharge: the caveat stays on the value.
 */
export function canRenderConfidentialityAtom(
  atom: unknown,
  policy: RenderPolicy,
): boolean {
  const max = normalizeAtomBound(policy.maxConfidentiality);
  if (max === undefined) {
    return true;
  }
  if (max.some((allowed) => deepEqual(allowed, atom))) {
    return true;
  }
  const kinds = policy.caveatKindAllow;
  return kinds !== undefined && kinds.length > 0 &&
    isObjectOrArray(atom) && atom.type === CFC_ATOM_TYPE.Caveat &&
    typeof atom.kind === "string" && kinds.includes(atom.kind);
}

/** A ceiling's atoms, deduplicated, or undefined for no ceiling. */
export function normalizeAtomBound(
  labels: readonly unknown[] | undefined,
): readonly CfcConfClause[] | undefined {
  if (labels === undefined) {
    return undefined;
  }
  return uniqueCfcAtoms(labels);
}

/**
 * The integrity a read of the value at the root of `labelView` consumes. An
 * entry describing a link the value was once reached through, rather than
 * the value, contributes none.
 */
export function integrityLabels(labelView: CfcLabelView): readonly CfcAtom[] {
  return uniqueCfcAtoms(
    labelView.entries.flatMap((entry) =>
      entry.path.length === 0 && readConsumesEntry("value", entry)
        ? [...(entry.label.integrity ?? [])]
        : []
    ),
  );
}

/** Whether a value with a label may be shown on a display. */
export type LabelDisplayFit = (label: IFCLabel) => boolean;

/**
 * The fit of a display that no authored policy covers, whose audience is
 * `owner` (§8.10.6): a label fits the default display ceiling built for
 * that audience, atom by atom, without the exchange rules that would admit
 * a space the owner reads, so it is never wider than a render's. A clause
 * of alternatives fits only as a whole, as an atom of the ceiling, not as
 * one of its alternatives would, so such a clause naming the owner among
 * others is withheld where a render with a resolver could show it. With no
 * owner, only a label naming no one fits, which any display may show. A
 * label too malformed to fit at all does not fit.
 */
export function defaultDisplayFit(owner?: string): LabelDisplayFit {
  const policy = rootRenderPolicyFor(
    owner === undefined
      ? { atoms: [], caveatKinds: [] }
      : defaultDisplayCeiling(owner),
  );
  return (label) => {
    try {
      return policy !== undefined &&
        (label.confidentiality ?? []).every((atom) =>
          atomRenderableUnderPolicy(atom, policy)
        );
    } catch {
      return false;
    }
  };
}
