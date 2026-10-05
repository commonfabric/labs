import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  changeCatalogMembership,
  isSharedSpaceCatalog,
  normalizeSharedSpaceRegistration,
  registerCatalogEntry,
  type SharedSpaceCatalog,
  sharedSpaceCatalogCause,
  sharedSpaceCatalogHost,
  sharedSpaceOfferKey,
  validateSharedSpaceMembershipChange,
} from "../src/shared-space-catalog-contract.ts";

const space = "did:key:shared-space";
const from = "did:key:sender";
const entry = {
  space,
  host: "https://spaces.example",
  kind: "loom",
  state: "saved",
  revision: "initial",
};
const catalog = { version: 1, entries: { [space]: entry }, offers: {} };

describe("shared-space-catalog-contract", () => {
  it("retains archive and first admission when another offer registers the same space", () => {
    const stored: SharedSpaceCatalog = { entries: {}, offers: {} };
    const registration = { ...entry, initialState: "archived" as const };
    const writes: unknown[] = [];
    const write = (path: readonly string[], value: unknown) =>
      writes.push({ path, value });
    const first = registerCatalogEntry(
      stored,
      registration,
      "first",
      123,
      write,
    );
    expect(first).toMatchObject({
      status: "registered",
      entry: { state: "archived", since: 123 },
    });
    const offered = {
      ...registration,
      initialState: "saved" as const,
      offer: { from, id: "one" },
    };
    const replay = registerCatalogEntry(stored, offered, "second", 456, write);
    expect(replay).toMatchObject({
      status: "existing",
      entry: { state: "archived", revision: "first", since: 123 },
    });
    expect(stored.offers[sharedSpaceOfferKey(from, "one")]).toMatchObject({
      space,
    });
    const before = writes.length;
    expect(registerCatalogEntry(stored, offered, "third", 789, write)).toEqual(
      replay,
    );
    expect(writes.length).toBe(before);
    expect(
      registerCatalogEntry(
        stored,
        { ...offered, host: "https://other.example" },
        "r",
        789,
        write,
      ),
    )
      .toEqual({ status: "conflict", reason: "host" });
    expect(
      registerCatalogEntry(
        stored,
        { ...offered, kind: "room" },
        "r",
        789,
        write,
      ),
    )
      .toEqual({ status: "conflict", reason: "kind" });
    expect(
      registerCatalogEntry(
        stored,
        { ...offered, space: "did:key:other-space" },
        "r",
        789,
        write,
      ),
    )
      .toEqual({ status: "conflict", reason: "offer" });
  });

  it("records first-offer provenance and confirms only the still-current membership action", () => {
    const stored: SharedSpaceCatalog = { entries: {}, offers: {} };
    const write = () => {};
    registerCatalogEntry(
      stored,
      { ...entry, offer: { from, id: "one" } },
      "first",
      123,
      write,
    );
    expect(stored.entries[space]).toMatchObject({ from, since: 123 });
    const action = {
      space,
      id: "archive",
      expectedRevision: "first",
      state: "archived" as const,
    };
    const applied = changeCatalogMembership(
      stored,
      action,
      "archived-revision",
      write,
    );
    expect(applied).toMatchObject({
      status: "applied",
      entry: { state: "archived", revision: "archived-revision" },
    });
    expect(changeCatalogMembership(stored, action, "unused", write))
      .toMatchObject({ status: "confirmed" });
    expect(
      changeCatalogMembership(
        stored,
        { ...action, state: "saved" },
        "unused",
        write,
      ),
    )
      .toEqual({ status: "conflict", reason: "action" });
    expect(
      changeCatalogMembership(
        stored,
        { ...action, id: "old-restore", state: "saved" },
        "unused",
        write,
      ),
    )
      .toEqual({ status: "conflict", reason: "revision" });
    expect(
      changeCatalogMembership(
        stored,
        { ...action, space: "did:key:missing" },
        "unused",
        write,
      ),
    )
      .toEqual({ status: "conflict", reason: "missing" });
  });

  it("refuses unsupported membership and opaque or inconsistent action evidence", () => {
    const action = {
      space,
      id: "archive",
      expectedRevision: "initial",
      state: "archived" as const,
    };
    const refused = () => {
      throw new Error("A refused action must not write.");
    };
    expect(
      changeCatalogMembership(
        { entries: { [space]: { ...entry, state: "left" } }, offers: {} },
        action,
        "unused",
        refused,
      ),
    )
      .toEqual({ status: "conflict", reason: "unsupported-state" });
    for (
      const lastAction of [null, [], "opaque", { id: "" }, {
        id: "old",
        expectedRevision: "old",
        state: "archived",
      }, { id: "x".repeat(321), expectedRevision: "old", state: "saved" }]
    ) {
      expect(
        changeCatalogMembership(
          { entries: { [space]: { ...entry, lastAction } }, offers: {} },
          action,
          "unused",
          refused,
        ),
      )
        .toEqual({ status: "conflict", reason: "action" });
    }
  });

  it("addresses each Home independently of display names and collection contents", () => {
    expect(sharedSpaceCatalogCause(from)).toEqual({ sharedSpaceCatalog: from });
    expect(sharedSpaceCatalogCause("did:key:other")).not.toEqual(
      sharedSpaceCatalogCause(from),
    );
    expect(() => sharedSpaceCatalogCause("did:bad name")).toThrow();
  });

  it("uses the common origin validator and canonicalizes accepted origins", () => {
    expect(sharedSpaceCatalogHost("HTTPS://SPACES.EXAMPLE:443/")).toBe(
      "https://spaces.example",
    );
    for (
      const host of [
        "https://spaces.example/api/..",
        "https://spaces.example/?",
        "https://@spaces.example",
        "file:///tmp/catalog",
      ]
    ) {
      expect(() => sharedSpaceCatalogHost(host)).toThrow();
    }
  });

  it("distinguishes sender/offer tuples without ambiguous delimiters", () => {
    expect(sharedSpaceOfferKey(from, "a:b")).not.toBe(
      sharedSpaceOfferKey(`${from}:a`, "b"),
    );
    for (
      const [sender, id] of [["not-a-DID", "id"], [from, ""], [
        from,
        "x".repeat(321),
      ]]
    ) {
      expect(() => sharedSpaceOfferKey(sender, id)).toThrow();
    }
  });

  it("copies validated input and keeps only the declared registration fields", () => {
    const offer = { from, id: "id", bearer: "must-not-be-stored" };
    const normalized = normalizeSharedSpaceRegistration({
      ...entry,
      kind: "loom",
      title: "",
      since: 123,
      offer,
    });
    offer.id = "changed";
    expect(normalized).toEqual({
      space,
      host: entry.host,
      kind: "loom",
      title: "",
      since: 123,
      offer: { from, id: "id" },
    });
  });

  it("rejects non-object offer identities from untyped callers", () => {
    for (const offer of [null, [], "sender-and-id"]) {
      const input = { ...entry, offer };
      expect(() => {
        // @ts-expect-error Untyped callers can supply a malformed offer identity.
        return normalizeSharedSpaceRegistration(input);
      })
        .toThrow("Invalid shared-space offer identity.");
    }
  });

  it("rejects malformed catalog records instead of interpreting them as empty", () => {
    expect(isSharedSpaceCatalog(catalog)).toBe(true);
    for (
      const value of [null, [], {}, {
        ...catalog,
        entries: [],
      }, { ...catalog, offers: null }]
    ) {
      expect(isSharedSpaceCatalog(value)).toBe(false);
    }
    for (
      const change of [
        { space: "did:key:another" },
        { host: "https://spaces.example/" },
        { host: "https://spaces.example/catalog" },
        { kind: "" },
        { title: "x".repeat(201) },
        { state: "" },
        { revision: "" },
        { from: "not-a-DID" },
        { since: -1 },
        { since: "2026-10-04T00:00:00Z" },
      ]
    ) {
      expect(
        isSharedSpaceCatalog({
          ...catalog,
          entries: { [space]: { ...entry, ...change } },
        }),
      ).toBe(false);
    }
  });

  it("retains additive fields and unfamiliar membership evidence", () => {
    for (const state of ["left", "future-state", "saved"]) {
      expect(isSharedSpaceCatalog({
        ...catalog,
        version: 2,
        extension: "preserved",
        entries: {
          [space]: {
            ...entry,
            state,
            lastAction: { futureEvidence: ["opaque"] },
          },
        },
      })).toBe(true);
    }
    expect(isSharedSpaceCatalog({ entries: {}, offers: {} })).toBe(true);
  });

  it("rejects invalid admission timestamps before registration", () => {
    for (const since of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => normalizeSharedSpaceRegistration({ ...entry, since }))
        .toThrow("Invalid shared-space registration");
    }
    expect(normalizeSharedSpaceRegistration({ ...entry, since: 0 }).since).toBe(
      0,
    );
  });

  it("requires each retained receipt to match its key and registered target", () => {
    const key = sharedSpaceOfferKey(from, "id");
    const receipt = {
      from,
      id: "id",
      space,
      host: entry.host,
      kind: entry.kind,
    };
    expect(isSharedSpaceCatalog({ ...catalog, offers: { [key]: receipt } }))
      .toBe(true);
    for (
      const change of [
        { from: "did:key:other" },
        { id: "other" },
        { space: "did:key:absent" },
        { host: "https://other.example" },
        { kind: "fabrichat-room" },
      ]
    ) {
      expect(
        isSharedSpaceCatalog({
          ...catalog,
          offers: { [key]: { ...receipt, ...change } },
        }),
      ).toBe(false);
    }
  });

  it("requires a concrete action and observed revision for membership changes", () => {
    const action = {
      space,
      id: "archive",
      expectedRevision: "initial",
      state: "archived" as const,
    };
    validateSharedSpaceMembershipChange(action);
    for (
      const value of [
        { ...action, id: "" },
        { ...action, expectedRevision: "" },
        { ...action, space: "local-id" },
        { ...action, state: "left" },
      ]
    ) {
      expect(() => validateSharedSpaceMembershipChange(value as typeof action))
        .toThrow();
    }
  });
});
