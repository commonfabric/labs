/**
 * Pins the types the inbox pointer is read through. The pointer carries the
 * label the inbox gives its offers, confidential to its owner. A served run
 * that reads a profile's pointer as an untyped link joins that label from
 * another space: its sends are then refused, and, when the event drain
 * delivers it, so is its record that it handled the event. Read as a typed
 * link, the pointer joins no confidentiality. Every reader, the host vetting
 * the inbox a profile advertises, Home's ensure step, the profiles' pointers,
 * the inbox the host names for it to adopt, the inbox Home holds, the ones it
 * retains and the one its refusal record names, Home's pointing step, the seed
 * step that points a profile once it is created, and a sender reading through
 * `profile-home.tsx`'s own types, therefore reads it as a typed link.
 *
 * The inbox an event names as refused is read as the same typed link, for a
 * narrower reason. The event carries no label of its own, so that link read
 * untyped joins nothing; what the type bars is naming a labeled member of the
 * inbox's result through it, such as `offers`, which joins the inbox's label.
 * For that link, the clause below about naming another member is the one that
 * matters.
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
import type { inboxPieceLinkSchema } from "@commonfabric/piece/ops";
import type { Schema } from "@commonfabric/runner";
import type {
  advertisedInbox,
  EnsurePrivateInboxEvent,
  PointTarget,
  PrivateInboxHolder,
  PrivateInboxOutput,
  PrivateInboxRefusalHolder,
  RetainedPrivateInboxes,
} from "./private-inbox.tsx";
import type { SeedProfileTarget } from "./profile-create.tsx";
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

/** A profile as the ensure step reads it, finding the advertised inbox. */
type EnsureStepProfile = NonNullable<
  NonNullable<Parameters<typeof advertisedInbox>[0]>[number]
>;

const ensureStepReachesOnlyTheName: ReachesOnlyTheName<
  PointeeOf<NonNullable<EnsureStepProfile["inbox"]>>
> = true;

const adoptedInboxReachesOnlyTheName: ReachesOnlyTheName<
  PointeeOf<{ piece?: EnsurePrivateInboxEvent["adopt"] }>
> = true;

const refusedInboxReachesOnlyTheName: ReachesOnlyTheName<
  PointeeOf<
    { piece?: NonNullable<EnsurePrivateInboxEvent["refused"]>["inbox"] }
  >
> = true;

const heldInboxReachesOnlyTheName: ReachesOnlyTheName<
  PointeeOf<PrivateInboxHolder>
> = true;

const retainedInboxReachesOnlyTheName: ReachesOnlyTheName<
  PointeeOf<{ piece?: RetainedPrivateInboxes[number] }>
> = true;

const recordedRefusalReachesOnlyTheName: ReachesOnlyTheName<
  PointeeOf<
    { piece?: NonNullable<PrivateInboxRefusalHolder["refusal"]>["inbox"] }
  >
> = true;

/** The pointee the host reads an advertised inbox's link as. */
type HostPointee = Schema<typeof inboxPieceLinkSchema> extends Cell<infer T> ? T
  : Schema<typeof inboxPieceLinkSchema>;

const hostReachesOnlyTheName: ReachesOnlyTheName<HostPointee> = true;

const pointingStepReachesOnlyTheName: ReachesOnlyTheName<
  PointeeOf<NonNullable<PointTarget["inbox"]>>
> = true;

const profileTypeReachesOnlyTheName: ReachesOnlyTheName<
  PointeeOf<ProfileInbox>
> = true;

const seedStepReachesOnlyTheName: ReachesOnlyTheName<
  PointeeOf<NonNullable<SeedProfileTarget["inbox"]>>
> = true;

describe("private-inbox pointer type", () => {
  it("types the host's pointer as a link naming only the inbox's name", () => {
    expect(hostReachesOnlyTheName).toBe(true);
  });

  it("types the ensure step's pointer as a link naming only the inbox's name", () => {
    expect(ensureStepReachesOnlyTheName).toBe(true);
  });

  it("types the inbox the ensure step adopts as a link naming only the inbox's name", () => {
    expect(adoptedInboxReachesOnlyTheName).toBe(true);
  });

  it("types the inbox the ensure step records as refused as a link naming only the inbox's name", () => {
    expect(refusedInboxReachesOnlyTheName).toBe(true);
  });

  it("types the inbox Home's refusal record names as a link naming only the inbox's name", () => {
    expect(recordedRefusalReachesOnlyTheName).toBe(true);
  });

  it("types the inbox Home holds as a link naming only the inbox's name", () => {
    expect(heldInboxReachesOnlyTheName).toBe(true);
  });

  it("types each inbox Home retains as a link naming only the inbox's name", () => {
    expect(retainedInboxReachesOnlyTheName).toBe(true);
  });

  it("types the pointing step's pointer as a link naming only the inbox's name", () => {
    expect(pointingStepReachesOnlyTheName).toBe(true);
  });

  it("types a profile's pointer as a link naming only the inbox's name", () => {
    expect(profileTypeReachesOnlyTheName).toBe(true);
  });

  it("types the seed step's pointer as a link naming only the inbox's name", () => {
    expect(seedStepReachesOnlyTheName).toBe(true);
  });
});
