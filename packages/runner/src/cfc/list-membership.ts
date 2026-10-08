/**
 * List membership at a display boundary (spec §4.9.5). A `Members{list,
 * subject}` alternative stands for everyone the list held at a list position
 * names; the render resolver mints `ListedIn(actingPrincipal, list)` for it by
 * a point query against that list, as `space-membership.ts` mints `HasRole`
 * for a `Space(...)` alternative from the space's ACL.
 *
 * The decision is split in two: {@link listedInEntries} is the pure check over
 * a list's entries, and a {@link ListMembershipProvider} reads a list from the
 * local replica and re-evaluates when it changes. Every failure resolves
 * nothing, so the `Members` alternative stays in force.
 */

import {
  CFC_ATOM_TYPE,
  type CfcListPosition,
  type CfcMembersAtom,
} from "@commonfabric/api/cfc";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isObjectOrArray } from "@commonfabric/utils/types";

import type { Cancel } from "../cancel.ts";
import { type CfcConfClause, clauseAlternatives } from "./clause.ts";

/**
 * One entry of a list as resolution sees it: the principal the entry pins,
 * and the confidentiality of the entry's own stored label. `principal` is
 * whatever the entry holds there; anything but a string pins nobody.
 */
export type ListEntryView = {
  readonly principal: unknown;
  readonly label: readonly CfcConfClause[];
};

/**
 * Whether `label` admits `principal` on its face: every clause has a
 * `User(principal)` alternative. This decides the label without exchange
 * rules or membership facts, so it can only under-admit, and an entry it
 * does not admit lists nobody.
 */
const labelNamesPrincipal = (
  label: readonly CfcConfClause[],
  principal: string,
): boolean =>
  label.every((clause) =>
    clauseAlternatives(clause).some((alternative) =>
      isObjectOrArray(alternative) &&
      alternative.type === CFC_ATOM_TYPE.User &&
      alternative.subject === principal
    )
  );

/**
 * Whether `principal` is listed by `entries` (spec §4.9.5): some entry pins
 * exactly that principal, and that entry's own label admits it. The second
 * condition is what keeps a viewer from learning, by seeing a value released
 * to the list, a membership bit drawn from data they cannot read.
 */
export const listedInEntries = (
  principal: string,
  entries: readonly ListEntryView[],
): boolean =>
  entries.some((entry) =>
    entry.principal === principal &&
    labelNamesPrincipal(entry.label, principal)
  );

const isListPosition = (value: unknown): value is CfcListPosition =>
  isObjectOrArray(value) && !Array.isArray(value) &&
  typeof value.space === "string" && typeof value.id === "string" &&
  Array.isArray(value.path) &&
  value.path.every((segment) => typeof segment === "string");

const isMembersAtom = (value: unknown): value is CfcMembersAtom =>
  isObjectOrArray(value) && value.type === CFC_ATOM_TYPE.Members &&
  isListPosition(value.list);

/**
 * The list positions a label's `Members` atoms name, each once, in label
 * order: the candidates of spec §4.9.5, computed from the label before
 * evaluation, so a list that a rule introduces while evaluating is never one.
 * The render resolver consults exactly these, and the reconciler watches
 * exactly these.
 */
export const listMembersInConfidentiality = (
  confidentiality: readonly CfcConfClause[],
): readonly CfcListPosition[] => {
  const lists: CfcListPosition[] = [];
  for (const clause of confidentiality) {
    for (const alternative of clauseAlternatives(clause)) {
      if (
        isMembersAtom(alternative) &&
        !lists.some((list) => deepEqual(list, alternative.list))
      ) {
        lists.push(alternative.list);
      }
    }
  }
  return lists;
};

/**
 * A synchronous list-membership oracle for the render fit, the list
 * counterpart of `SpaceMembershipProvider`.
 */
export interface ListMembershipProvider {
  /**
   * Whether the acting principal is listed at `list` in the local replica.
   * An absent, unsynced or unreadable list, or one whose position declares no
   * writer, lists nobody.
   */
  listed(list: CfcListPosition): boolean;

  /**
   * Subscribe to the list at `list` and the one document it may link to;
   * `onChange` fires when either later syncs or changes, never synchronously
   * at subscribe time. Returns a cancel.
   */
  subscribe(list: CfcListPosition, onChange: () => void): Cancel;
}
