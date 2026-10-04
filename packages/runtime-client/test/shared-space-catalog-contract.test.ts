import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  isSharedSpaceCatalog,
  normalizeSharedSpaceRegistration,
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
