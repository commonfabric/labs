import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { ServedAclChange } from "@commonfabric/memory/v2/server";
import {
  type ServedAclChangeData,
  servedAclChangeData,
  servedAclChangeOf,
} from "../../src/executor/served-acl-change.ts";

const space = "did:key:served-acl-space";
const alice = "did:key:served-acl-alice";
const bob = "did:key:served-acl-bob";

/** Alice's change granting Bob `WRITE` in `space`, as data. */
const data: ServedAclChangeData = {
  space,
  actingPrincipal: alice,
  actingSession: "session-alice",
  capabilityRef: "event-consequence:evt-1",
  sourceEvent: { space, sidecarId: "of:sidecar", eventId: "evt-1" },
  changes: [{ principal: bob, level: "WRITE", actor: alice }],
};

describe("served-acl-change", () => {
  describe("servedAclChangeData()", () => {
    it("returns the change with its list in place of its function", () => {
      const change: ServedAclChange & ServedAclChangeData = {
        ...data,
        change: () => ({ [alice]: "OWNER" }),
      };

      expect(servedAclChangeData(change)).toEqual(data);
      expect("change" in servedAclChangeData(change)).toBe(false);
    });

    it("throws for a change that carries no list", () => {
      const { changes: _changes, ...unlisted } = data;
      const change: ServedAclChange = {
        ...unlisted,
        change: () => ({ [alice]: "OWNER" }),
      };

      expect(() => servedAclChangeData(change)).toThrow(
        `the access-list change to ${space} carries no change list`,
      );
    });
  });

  describe("servedAclChangeOf()", () => {
    it("returns a change whose function applies the list to the stored access list", () => {
      const change = servedAclChangeOf(data);

      expect(change.change({ [alice]: "OWNER" })).toEqual({
        [alice]: "OWNER",
        [bob]: "WRITE",
      });
      expect(() => change.change({ [bob]: "OWNER" })).toThrow(
        `which ${alice} does not hold`,
      );
      expect(servedAclChangeData(change)).toEqual(data);
    });

    it("throws for a list holding a change made by an actor other than the carried one", () => {
      const borrowed: ServedAclChangeData = {
        ...data,
        changes: [
          { principal: bob, level: "WRITE", actor: alice },
          { principal: bob, level: "OWNER", actor: bob },
        ],
      };

      expect(() => servedAclChangeOf(borrowed)).toThrow(
        `is made by ${alice}, but a change in it names ${bob} as its actor`,
      );
    });
  });
});
