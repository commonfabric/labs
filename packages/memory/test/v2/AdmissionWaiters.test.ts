import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { AdmissionWaiters } from "../../v2/admission-waiters.ts";

const SPACE = "did:key:z6Mk-waiters-space";
const OTHER_SPACE = "did:key:z6Mk-waiters-other-space";
const GUEST = "did:key:z6Mk-waiters-guest";
const CAROL = "did:key:z6Mk-waiters-carol";

const everyone = () => true;

describe("AdmissionWaiters", () => {
  describe("instance members", () => {
    describe("take()", () => {
      it("returns each entry for the space whose principal is admitted, once", () => {
        const waiters = new AdmissionWaiters();
        waiters.add("one", SPACE, GUEST);
        waiters.add("one", SPACE, CAROL);
        waiters.add("two", SPACE, GUEST);
        waiters.add("one", OTHER_SPACE, GUEST);

        expect(waiters.take(SPACE, (principal) => principal === GUEST))
          .toEqual([
            { connectionId: "one", principal: GUEST },
            { connectionId: "two", principal: GUEST },
          ]);
        expect(waiters.take(SPACE, everyone)).toEqual([
          { connectionId: "one", principal: CAROL },
        ]);
        expect(waiters.take(SPACE, everyone)).toEqual([]);
        expect(waiters.take(OTHER_SPACE, everyone)).toEqual([
          { connectionId: "one", principal: GUEST },
        ]);
      });
    });

    describe("add()", () => {
      it("keeps one entry for a refusal recorded twice", () => {
        const waiters = new AdmissionWaiters(2);
        waiters.add("one", SPACE, GUEST);
        waiters.add("one", SPACE, GUEST);
        waiters.add("one", OTHER_SPACE, GUEST);

        expect(waiters.take(SPACE, everyone)).toEqual([
          { connectionId: "one", principal: GUEST },
        ]);
        expect(waiters.take(OTHER_SPACE, everyone)).toEqual([
          { connectionId: "one", principal: GUEST },
        ]);
      });

      it("drops a connection's oldest entry past its limit, and no other connection's", () => {
        const waiters = new AdmissionWaiters(2);
        waiters.add("one", SPACE, GUEST);
        waiters.add("two", SPACE, GUEST);
        waiters.add("one", SPACE, CAROL);
        waiters.add("one", OTHER_SPACE, GUEST);

        expect(waiters.take(SPACE, everyone)).toEqual([
          { connectionId: "one", principal: CAROL },
          { connectionId: "two", principal: GUEST },
        ]);
        expect(waiters.take(OTHER_SPACE, everyone)).toEqual([
          { connectionId: "one", principal: GUEST },
        ]);
      });

      it("drops the only entry of a connection with a limit of one, keeping the new one removable", () => {
        const waiters = new AdmissionWaiters(1);
        waiters.add("one", SPACE, GUEST);
        waiters.add("one", OTHER_SPACE, GUEST);

        expect(waiters.take(SPACE, everyone)).toEqual([]);
        expect(waiters.take(OTHER_SPACE, everyone)).toEqual([
          { connectionId: "one", principal: GUEST },
        ]);
        expect(waiters.take(OTHER_SPACE, everyone)).toEqual([]);
      });
    });

    describe("remove()", () => {
      it("drops only the entry it names", () => {
        const waiters = new AdmissionWaiters();
        waiters.add("one", SPACE, GUEST);
        waiters.add("one", SPACE, CAROL);
        waiters.remove("one", SPACE, GUEST);

        expect(waiters.take(SPACE, everyone)).toEqual([
          { connectionId: "one", principal: CAROL },
        ]);
      });
    });

    describe("removePrincipal()", () => {
      it("drops every entry of the principal on the connection, and no other", () => {
        const waiters = new AdmissionWaiters();
        waiters.add("one", SPACE, GUEST);
        waiters.add("one", OTHER_SPACE, GUEST);
        waiters.add("one", SPACE, CAROL);
        waiters.add("two", SPACE, GUEST);
        waiters.removePrincipal("one", GUEST);

        expect(waiters.take(SPACE, everyone)).toEqual([
          { connectionId: "one", principal: CAROL },
          { connectionId: "two", principal: GUEST },
        ]);
        expect(waiters.take(OTHER_SPACE, everyone)).toEqual([]);
      });
    });

    describe("removeConnection()", () => {
      it("drops every entry on the connection, and no other", () => {
        const waiters = new AdmissionWaiters();
        waiters.add("one", SPACE, GUEST);
        waiters.add("one", OTHER_SPACE, CAROL);
        waiters.add("two", SPACE, GUEST);
        waiters.removeConnection("one");

        expect(waiters.take(SPACE, everyone)).toEqual([
          { connectionId: "two", principal: GUEST },
        ]);
        expect(waiters.take(OTHER_SPACE, everyone)).toEqual([]);
      });
    });
  });
});
