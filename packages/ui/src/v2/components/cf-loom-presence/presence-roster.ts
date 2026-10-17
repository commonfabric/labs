/**
 * Who a presence room's records say is present, folded to one entry per
 * person. The relay stamps each record with the DID of the session that
 * published it, and a person with the Loom open on two devices holds two
 * records under one principal, so a roster is by principal rather than by
 * membership. A record the relay stamped no principal on names nobody a
 * roster could show, and is left out, as is the viewer's own principal: a
 * roster says who else is here.
 */

import type { PresenceRecord } from "@commonfabric/runtime-client";

/** One person present, however many sessions they hold the room through. */
export interface PresentParticipant {
  /** The DID the relay stamped on the person's records. */
  readonly principal: string;

  /** The display name of the person's latest record. */
  readonly name: string;
}

/**
 * Returns the people `records` say are present other than `self`, one per
 * principal, named by the record of theirs with the highest revision, in
 * name order with the principal breaking a tie. A record with no principal
 * is left out.
 */
export function presentParticipantsOf(
  records: readonly PresenceRecord[],
  self: string | undefined,
): PresentParticipant[] {
  const latest = new Map<string, PresenceRecord>();
  for (const record of records) {
    const principal = record.principal;
    if (principal === undefined || principal === "" || principal === self) {
      continue;
    }
    const held = latest.get(principal);
    if (held === undefined || held.revision < record.revision) {
      latest.set(principal, record);
    }
  }
  return [...latest.entries()]
    .map(([principal, record]) => ({ principal, name: record.name }))
    .sort((left, right) =>
      left.name.localeCompare(right.name) ||
      left.principal.localeCompare(right.principal)
    );
}
