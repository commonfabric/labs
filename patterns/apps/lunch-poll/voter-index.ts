/**
 * Indexes `members` by `memberKey`, and returns the lookup that gives a
 * subject the member `same` accepts for it, or `undefined` when no member
 * does.
 *
 * A key here is cheap to derive and says less than the comparison does: two
 * members that are not the same can share one — a profile cell's entity id,
 * say, which two cells in different spaces can share — and two that are the
 * same can hold different ones, because the comparison resolves the links a
 * key reads as written. So a key narrows the search and never settles it. A
 * member is returned only when `same` accepts it, and a key that names no
 * accepted member sends the lookup over every member, which is what reaches a
 * member `memberKey` cannot key and a member whose key is not the subject's.
 */
export const indexBy = <Member, Subject>(
  members: readonly Member[],
  memberKey: (member: Member) => string | undefined,
  subjectKey: (subject: Subject) => string | undefined,
  same: (member: Member, subject: Subject) => boolean,
): (subject: Subject) => Member | undefined => {
  // Built on the first lookup, so an index nothing is looked up in costs
  // nothing.
  let byKey: Map<string, Member[]> | undefined;
  return (subject) => {
    if (byKey === undefined) {
      byKey = new Map();
      for (const member of members) {
        const key = memberKey(member);
        if (key === undefined) continue;
        const known = byKey.get(key);
        if (known === undefined) {
          byKey.set(key, [member]);
        } else {
          known.push(member);
        }
      }
    }
    const key = subjectKey(subject);
    const narrowed = key === undefined ? undefined : byKey.get(key);
    const found = narrowed?.find((member) => same(member, subject));
    return found ?? members.find((member) => same(member, subject));
  };
};
