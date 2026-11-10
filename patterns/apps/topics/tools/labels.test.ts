import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { IFCLabel } from "@commonfabric/runner/cfc";

import {
  admits,
  atomText,
  type PartLabels,
  redact,
  shortDid,
  UNREADABLE,
} from "./labels.ts";
import { changes } from "./events.ts";
import type { Topic } from "./mirror.ts";

/** A display that admits a label naming no one. */
const fit = (label: IFCLabel) => (label.confidentiality ?? []).length === 0;

/** Labels whose confidentiality names `who`. */
function only(who: string): PartLabels {
  return {
    label: { confidentiality: [who] },
    confidentiality: [[who]],
    integrity: [],
    authors: [],
  };
}

/** A Topic with a comment and a link, active at 50. */
function topic(labels?: PartLabels): Topic {
  return {
    number: "1",
    address: "of:entry",
    piece: "of:piece",
    title: "Secret plans",
    body: "The plans.",
    createdAt: 10,
    updatedAt: 50,
    createdBy: "Sol (agent)",
    lastActivityAt: 50,
    comments: [{ author: "Al", body: "Hi.", sentAt: 20, removed: false }],
    links: [{
      kind: "pr",
      url: "https://example.com",
      label: "Fix",
      addedBy: "Bo",
      addedAt: 30,
      removed: false,
    }],
    mentions: ["of:other"],
    ...(labels === undefined ? {} : { labels }),
  };
}

describe("labels", () => {
  describe("admits()", () => {
    it("returns `true` for a part with no labels or labels the display fits", () => {
      expect(admits(fit, undefined)).toBe(true);
      expect(admits(fit, { ...only("x"), label: {} })).toBe(true);
    });

    it("returns `false` for labels the display does not fit, or cannot read", () => {
      expect(admits(fit, only("x"))).toBe(false);
      expect(admits(() => true, UNREADABLE)).toBe(false);
    });
  });

  describe("redact()", () => {
    it("returns a Topic the display admits as it was", () => {
      expect(redact([topic()], fit)).toEqual([topic()]);
    });

    it("returns a withheld Topic blanked, keeping its labels, active when what is shown was", () => {
      const [withheld] = redact([topic(only("x"))], fit);

      expect(withheld).toMatchObject({
        title: "",
        body: "",
        createdBy: "",
        createdAt: 0,
        mentions: [],
        lastActivityAt: 30,
        labels: only("x"),
      });
      expect(withheld.comments[0].body).toBe("Hi.");
    });

    it("returns a withheld comment as not taken back, so that taking it back changes nothing shown", () => {
      const before = topic();
      before.comments[0].labels = only("x");
      const after = topic();
      after.comments[0] = {
        ...after.comments[0],
        removed: true,
        removedAt: 60,
        labels: only("x"),
      };

      expect(redact([after], fit)[0].comments[0].removed).toBe(false);
      expect(changes(redact([before], fit), redact([after], fit), 70))
        .toEqual([]);
    });

    it("returns Topics between which a Topic's being withheld takes back no mention", () => {
      const other = { ...topic(), number: "2", address: "of:other" };
      const before = [topic(), other];
      const after = [topic(only("x")), other];

      expect(changes(redact(before, fit), redact(after, fit), 70))
        .toEqual([]);
      expect(changes(redact(after, fit), redact(before, fit), 70))
        .toEqual([]);
    });

    it("returns Topics between which a withheld comment's arrival, and a Topic's being withheld, make no event", () => {
      const before = topic();
      const after = topic(only("x"));
      after.comments.push({
        author: "Bo",
        body: "Secret.",
        sentAt: 60,
        removed: false,
        labels: only("x"),
      });

      expect(changes(redact([before], fit), redact([after], fit), 70))
        .toEqual([]);
    });

    it("returns a shown Topic active when what is shown of it was", () => {
      const labeled = topic();
      labeled.links[0].labels = only("x");
      const [shown] = redact([labeled], fit);

      expect(shown.lastActivityAt).toBe(50);

      labeled.updatedAt = 10;
      const [older] = redact([labeled], fit);

      // The withheld link, added at 30, does not count.
      expect(older.lastActivityAt).toBe(20);
    });

    it("returns a withheld comment and link blanked, keeping their labels", () => {
      const labeled = topic();
      labeled.comments[0].labels = only("x");
      labeled.links[0].labels = UNREADABLE;
      const [shown] = redact([labeled], fit);

      expect(shown.comments[0]).toEqual({
        author: "",
        body: "",
        sentAt: 0,
        removed: false,
        withheld: true,
        labels: only("x"),
      });
      expect(shown.links[0]).toEqual({
        kind: "",
        url: "",
        label: "",
        addedBy: "",
        removed: false,
        withheld: true,
        labels: UNREADABLE,
      });
      expect(shown.title).toBe("Secret plans");
    });
  });

  describe("shortDid()", () => {
    it("returns a key's DID cut to its start and end, and other text as it was", () => {
      expect(
        shortDid("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"),
      )
        .toMatch(/^did:key:z6Mk.*…/);
      expect(shortDid("someone")).toBe("someone");
    });
  });

  describe("atomText()", () => {
    it("returns an atom as its type and subject", () => {
      expect(atomText({ kind: "authored-by", subject: "did:key:zA" }))
        .toBe("authored-by(did:key:zA)");
    });
  });
});
