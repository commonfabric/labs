/**
 * Pins the types the inbox pointer is read through. The pointer carries the
 * label the inbox gives its offers, confidential to its owner. A served run
 * that reads a profile's pointer as an untyped link joins that label from
 * another space: its sends are then refused, and, when the event drain
 * delivers it, so is its record that it handled the event. Read as a typed
 * link, the pointer joins no confidentiality. Both readers, Home's pointing
 * step and a sender reading through `profile-home.tsx`'s own types, therefore
 * read it as a typed link.
 *
 * The check is made by the type checker. A pointee that is `unknown` or `any`
 * fails to compile here under `deno task check`, and so does one naming a
 * member of the inbox's result other than its name: which typed shapes join
 * the label is not settled member by member, so a type that grows toward the
 * inbox's result is sent back for someone to decide. The test body only
 * records that this file compiled.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { Cell, NAME } from "commonfabric";
import type { PointTarget, PrivateInboxOutput } from "./private-inbox.tsx";
import type { ProfileInbox } from "./profile-home.tsx";

/** The type a pointer holder's `piece` link reaches. */
type PointeeOf<Holder> = Holder extends { piece?: Cell<infer Pointee> }
  ? Pointee
  : never;

/**
 * `true` when `Pointee` is neither `unknown` nor `any` and names no member of
 * the inbox's result but its name.
 */
type ReachesOnlyTheName<Pointee> = unknown extends Pointee ? false
  : [
    Exclude<Extract<keyof Pointee, keyof PrivateInboxOutput>, typeof NAME>,
  ] extends [never] ? true
  : false;

const pointingStepReachesOnlyTheName: ReachesOnlyTheName<
  PointeeOf<NonNullable<PointTarget["inbox"]>>
> = true;

const profileTypeReachesOnlyTheName: ReachesOnlyTheName<
  PointeeOf<ProfileInbox>
> = true;

describe("private-inbox pointer type", () => {
  it("types the pointing step's pointer as a link naming only the inbox's name", () => {
    expect(pointingStepReachesOnlyTheName).toBe(true);
  });

  it("types a profile's pointer as a link naming only the inbox's name", () => {
    expect(profileTypeReachesOnlyTheName).toBe(true);
  });
});
