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
      offer,
    });
    offer.id = "changed";
    expect(normalized).toEqual({
      space,
      host: entry.host,
      kind: "loom",
      title: "",
      offer: { from, id: "id" },
    });
  });

  it("rejects malformed catalog records instead of interpreting them as empty", () => {
    expect(isSharedSpaceCatalog(catalog)).toBe(true);
    for (
      const value of [null, [], {}, { ...catalog, version: 2 }, {
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
        { kind: "" },
        { title: "x".repeat(201) },
        { state: "left" },
        { revision: "" },
        { lastAction: {} },
        {
          lastAction: {
            id: "a",
            expectedRevision: "initial",
            state: "archived",
          },
        },
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
