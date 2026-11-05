/**
 * Board fixture for the bulk-survey drill: a holder whose stored input
 * carries a collection of `Member` sub-pieces, created through its own
 * `addMember` verb — which is exactly why they are absent from the piece
 * registry, the absence the survey's containment check exists to expose.
 * Nothing else deploys this file: the drill owns its subject.
 */

import {
  action,
  type Default,
  NAME,
  pattern,
  type Stream,
  type Writable,
} from "commonfabric";

import { Member, type MemberOutput } from "./bulk-member.tsx";

/** File a new member on the board. */
interface AddMemberEvent {
  /** One line naming the member. */
  title: string;
}

interface AddMemberResult {
  /** The member this call created. */
  member: MemberOutput;
}

/** Seed many members in one call; the board-sized set arrives as one write. */
interface SeedMembersEvent {
  /** How many members to file. */
  count: number;
}

interface SeedMembersResult {
  /** How many members this call filed. */
  filed: number;
}

interface BoardInput {
  items?: Writable<MemberOutput[] | Default<[]>>;
}

/** A board of members; the collection changes only through `addMember`. */
interface BoardOutput {
  [NAME]: string;
  items: MemberOutput[];

  /** File a new member on the board. */
  addMember: Stream<AddMemberEvent, AddMemberResult>;

  /** Seed many members in one call. */
  seedMembers: Stream<SeedMembersEvent, SeedMembersResult>;
}

export default pattern<BoardInput, BoardOutput>(({ items }) => {
  const addMember = action<AddMemberEvent, AddMemberResult>((event) => {
    const trimmed = (event.title ?? "").trim();
    if (!trimmed) throw new Error("addMember: title must be non-empty");
    const member = Member({ title: trimmed });
    items.push(member);
    return { member };
  });

  const seedMembers = action<SeedMembersEvent, SeedMembersResult>(
    (event) => {
      const count = event.count ?? 0;
      if (!Number.isSafeInteger(count) || count < 1) {
        throw new Error("seedMembers: count must be a positive integer");
      }
      for (let index = 0; index < count; index += 1) {
        items.push(Member({ title: `seed-${index}` }));
      }
      return { filed: count };
    },
  );

  return {
    [NAME]: "Bulk survey board",
    items,
    addMember,
    seedMembers,
  };
});
