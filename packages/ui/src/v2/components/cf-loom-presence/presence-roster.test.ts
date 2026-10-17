import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { PresenceRecord } from "@commonfabric/runtime-client";
import { presentParticipantsOf } from "./presence-roster.ts";

const record = (
  overrides: Partial<PresenceRecord> & { participantId: string },
): PresenceRecord => ({
  principal: "did:key:z6Mk-ada",
  revision: 1,
  name: "Ada",
  facets: {},
  ...overrides,
});

describe("presentParticipantsOf()", () => {
  it("returns one entry per principal, named by the record with the highest revision", () => {
    expect(presentParticipantsOf([
      record({ participantId: "p1", revision: 2, name: "Ada on the Mac" }),
      record({ participantId: "p2", revision: 5, name: "Ada on the phone" }),
      record({ participantId: "p3", revision: 9, name: "Ada on the Mac" }),
    ], undefined)).toEqual([
      { principal: "did:key:z6Mk-ada", name: "Ada on the Mac" },
    ]);
  });

  it("leaves out the viewer's own principal and keeps the others", () => {
    expect(presentParticipantsOf([
      record({ participantId: "p1" }),
      record({
        participantId: "p2",
        principal: "did:key:z6Mk-bob",
        name: "Bob",
      }),
    ], "did:key:z6Mk-ada")).toEqual([
      { principal: "did:key:z6Mk-bob", name: "Bob" },
    ]);
  });

  it("leaves out a record the relay stamped no principal on", () => {
    expect(presentParticipantsOf([
      record({ participantId: "p1", principal: undefined, name: "Nobody" }),
      record({ participantId: "p2", principal: "", name: "Nobody either" }),
      record({ participantId: "p3" }),
    ], undefined)).toEqual([{ principal: "did:key:z6Mk-ada", name: "Ada" }]);
  });

  it("orders by name, then by principal", () => {
    expect(
      presentParticipantsOf([
        record({
          participantId: "p1",
          principal: "did:key:z6Mk-c",
          name: "Zed",
        }),
        record({
          participantId: "p2",
          principal: "did:key:z6Mk-b",
          name: "Ada",
        }),
        record({
          participantId: "p3",
          principal: "did:key:z6Mk-a",
          name: "Ada",
        }),
      ], undefined).map(({ principal }) => principal),
    ).toEqual([
      "did:key:z6Mk-a",
      "did:key:z6Mk-b",
      "did:key:z6Mk-c",
    ]);
  });

  it("returns nothing for an empty room", () => {
    expect(presentParticipantsOf([], "did:key:z6Mk-ada")).toEqual([]);
  });
});
