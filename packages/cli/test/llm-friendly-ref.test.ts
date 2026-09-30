import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ValidationError } from "@cliffy/command";
import {
  isReference,
  normalizeLLMFriendlyRef,
  splitArgumentSuffix,
  validateEmbeddedSpaces,
} from "../lib/llm-friendly-ref.ts";
import { createSession, Identity } from "@commonfabric/identity";
import { isDID } from "@commonfabric/identity/did";

// The 43-character id length matches the entity ids the runtime mints, and
// clears the runner parser's handle-length threshold.
const ID = "baedreiabcdefghijklmnopqrstuvwxyz0123456789";
const HANDLE = `of:fid1:${ID}`;
const DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OTHER_DID = "did:key:z6MkrZ1r5XBFZjBU34qyD8fueMbMRkKw17BZaq2ivKFjnz2z";

const signer = await Identity.fromPassphrase("cf-llm-friendly-ref");

/** A session on `space`, the way `loadPieces` opens one. */
const sessionOn = (space: string) =>
  createSession(
    isDID(space)
      ? { identity: signer, spaceDid: space }
      : { identity: signer, spaceName: space },
  );

/** The DID a space name derives to, which is what the check holds it to. */
const didFor = async (name: string) => (await sessionOn(name)).space;

describe("llm-friendly-ref", () => {
  it("reports malformed target members and qualifiers as usage errors", () => {
    for (const target of ["glaze#unknown", "glaze@unknown=value"]) {
      expect(() => splitArgumentSuffix(target)).toThrow(ValidationError);
    }
  });

  it("returns undefined for references outside the reference form", () => {
    expect(normalizeLLMFriendlyRef("piece1")).toBeUndefined();
    expect(normalizeLLMFriendlyRef("piece1@user")).toBeUndefined();
    expect(normalizeLLMFriendlyRef(HANDLE)).toBeUndefined();
    expect(normalizeLLMFriendlyRef("piece1/path/to/field")).toBeUndefined();
  });

  it("reads the rooting as what makes a token a reference", () => {
    expect(isReference("/tracker")).toBe(true);
    expect(isReference(`  /${HANDLE}  `)).toBe(true);
    expect(isReference("tracker")).toBe(false);
    expect(isReference("items/0/title")).toBe(false);
  });

  it("normalizes an id-only reference to the bare handle", () => {
    expect(normalizeLLMFriendlyRef(`/${HANDLE}`)).toEqual({
      pieceId: HANDLE,
      path: [],
    });
  });

  it("retains pins on rooted and complete references for the caller", () => {
    const pin = "a".repeat(43);
    for (const reference of [`/${HANDLE}`, `//${DID}/${HANDLE}`]) {
      expect(normalizeLLMFriendlyRef(`${reference}@pin=${pin}/a@pin=literal`, {
        space: DID,
      })).toEqual({ pieceId: HANDLE, pin, path: ["a@pin=literal"] });
    }
  });

  it("inherits caller scope on rooted and complete references", () => {
    for (const scope of ["space", "user", "session"] as const) {
      for (const reference of [`/${HANDLE}`, `//${DID}/${HANDLE}`]) {
        for (const qualifier of ["", "@inherit", "@scope=inherit"]) {
          expect(normalizeLLMFriendlyRef(`${reference}${qualifier}/items`, {
            space: DID,
            scope,
          })).toEqual({ pieceId: HANDLE, scope, path: ["items"] });
        }
        expect(normalizeLLMFriendlyRef(`${reference}@space/items`, {
          space: DID,
          scope,
        })).toEqual({ pieceId: HANDLE, scope: "space", path: ["items"] });
      }
    }
  });

  it("inherits a scope-only context without inventing a space", () => {
    expect(normalizeLLMFriendlyRef(`/${HANDLE}@inherit`, { scope: "session" }))
      .toEqual({ pieceId: HANDLE, scope: "session", path: [] });
    expect(() => normalizeLLMFriendlyRef(`/${HANDLE}@inherit`))
      .toThrow(/requires a reference context/);
  });

  it("names the piece by slug where a handle is accepted", () => {
    expect(normalizeLLMFriendlyRef("/tracker")).toEqual({
      pieceId: "tracker",
      path: [],
    });
    expect(normalizeLLMFriendlyRef("/tracker/items/0/title")).toEqual({
      pieceId: "tracker",
      path: ["items", 0, "title"],
    });
    expect(normalizeLLMFriendlyRef("/tracker@session/draft")).toEqual({
      pieceId: "tracker",
      scope: "session",
      path: ["draft"],
    });
  });

  it("names the space by name where a DID is accepted", () => {
    expect(normalizeLLMFriendlyRef("//my-space/tracker/items")).toEqual({
      pieceId: "tracker",
      embeddedSpace: "my-space",
      path: ["items"],
    });
  });

  it("refuses the retired named-space migration alias", () => {
    expect(() => normalizeLLMFriendlyRef("/@my-space/tracker/items"))
      .toThrow(
        "The named-space prefix `/@my-space/` is retired; use `//my-space/`.",
      );
  });

  it("settles two space names against each other at parse time", () => {
    // Same name, same space: nothing is left for the session to check.
    expect(
      normalizeLLMFriendlyRef("//my-space/tracker", { space: "my-space" }),
    ).toEqual({ pieceId: "tracker", path: [] });
    expect(() =>
      normalizeLLMFriendlyRef("//my-space/tracker", { space: "other-space" })
    ).toThrow(
      `Reference names space "my-space" but the command targets ` +
        `space "other-space".`,
    );
  });

  it("defers a space name against a DID target space", () => {
    // Only a derivation can compare the two spellings, and that needs the
    // session the target space is resolved by.
    expect(
      normalizeLLMFriendlyRef("//my-space/tracker", { space: DID }),
    ).toEqual({
      pieceId: "tracker",
      embeddedSpace: "my-space",
      path: [],
    });
  });

  it("refuses a piece segment that is neither a handle nor a slug", () => {
    expect(() => normalizeLLMFriendlyRef("/of:short")).toThrow(
      `"of:short" is neither a piece handle (of:fid1:...) nor a slug.`,
    );
    expect(() => normalizeLLMFriendlyRef("/Tracker")).toThrow(
      /is not a slug/,
    );
    expect(() => normalizeLLMFriendlyRef("/my--tracker")).toThrow(
      /is not a slug/,
    );
  });

  it("converts embedded path segments the way a positional path is", () => {
    expect(normalizeLLMFriendlyRef(`/${HANDLE}/items/0/title`)).toEqual({
      pieceId: HANDLE,
      path: ["items", 0, "title"],
    });
  });

  it("converts only canonical array-index segments to numbers", () => {
    expect(normalizeLLMFriendlyRef(`/${HANDLE}/items/0/10/01/007`)).toEqual({
      pieceId: HANDLE,
      path: ["items", 0, 10, "01", "007"],
    });
  });

  it("keeps canonical segments beyond the array-index range as strings", () => {
    expect(
      normalizeLLMFriendlyRef(
        `/${HANDLE}/items/4294967294/4294967295/9007199254740993`,
      ),
    ).toEqual({
      pieceId: HANDLE,
      path: ["items", 4294967294, "4294967295", "9007199254740993"],
    });
  });

  it("parses a scope suffix on the id segment", () => {
    expect(normalizeLLMFriendlyRef(`/${HANDLE}@session/draft`)).toEqual({
      pieceId: HANDLE,
      scope: "session",
      path: ["draft"],
    });
  });

  it("resolves inherited scope when the command supplies a space context", () => {
    expect(normalizeLLMFriendlyRef("/tracker@inherit", { space: "bakery" }))
      .toEqual({ pieceId: "tracker", scope: "space", path: [] });
    expect(() => normalizeLLMFriendlyRef("/tracker@inherit")).toThrow(
      /requires a reference context/,
    );
  });

  it("rejects an invalid scope suffix", () => {
    expect(() => normalizeLLMFriendlyRef(`/${HANDLE}@bogus`)).toThrow(
      /Invalid scope suffix/,
    );
  });

  it("accepts an embedded space DID that matches the target space", () => {
    expect(
      normalizeLLMFriendlyRef(`/@${DID}/${HANDLE}/value`, { space: DID }),
    ).toEqual({
      pieceId: HANDLE,
      path: ["value"],
    });
  });

  it("rejects an embedded DID that differs from a DID target space", () => {
    expect(() =>
      normalizeLLMFriendlyRef(`/@${DID}/${HANDLE}`, { space: OTHER_DID })
    ).toThrow(
      `Reference names space "${DID}" but the command targets ` +
        `space "${OTHER_DID}".`,
    );
  });

  it("defers an embedded DID when the target space is a name", () => {
    expect(
      normalizeLLMFriendlyRef(`/@${DID}/${HANDLE}/value`, {
        space: "my-space",
      }),
    ).toEqual({
      pieceId: HANDLE,
      embeddedSpace: DID,
      path: ["value"],
    });
  });

  it("passes a deferred embedded DID that matches the resolved space", async () => {
    const session = await sessionOn(DID);
    await validateEmbeddedSpaces([DID], session);
    await validateEmbeddedSpaces(undefined, session);
  });

  it("rejects a deferred embedded DID against another resolved space", async () => {
    await expect(validateEmbeddedSpaces([DID], await sessionOn(OTHER_DID)))
      .rejects.toThrow(
        `Reference names space "${DID}" but the command targets ` +
          `space "${OTHER_DID}".`,
      );
  });

  it("holds a deferred space name to the DID it derives to", async () => {
    // Both sides reach a DID through the session's own derivation, so a name
    // and the DID it stands for compare equal.
    const session = await sessionOn("my-space");
    await validateEmbeddedSpaces(["my-space"], session);
    await validateEmbeddedSpaces([await didFor("my-space")], session);
    await expect(validateEmbeddedSpaces(["their-space"], session))
      .rejects.toThrow(
        `Reference names space "their-space" but the command targets ` +
          `space "${await didFor("my-space")}".`,
      );
  });

  it('reads a piece member "#argument" as the arguments-cell selection', () => {
    expect(normalizeLLMFriendlyRef(`/${HANDLE}#argument`)).toEqual({
      pieceId: HANDLE,
      input: true,
      path: [],
    });
    // The member precedes qualifiers and the pointer.
    expect(
      normalizeLLMFriendlyRef(`/@${DID}/${HANDLE}#argument@user/draft`, {
        space: "my-space",
      }),
    ).toEqual({
      pieceId: HANDLE,
      scope: "user",
      embeddedSpace: DID,
      input: true,
      path: ["draft"],
    });
  });

  it("reads result members and hash characters in path keys", () => {
    expect(normalizeLLMFriendlyRef(`/${HANDLE}#result`)).toEqual({
      pieceId: HANDLE,
      path: [],
    });
    expect(normalizeLLMFriendlyRef(`/${HANDLE}/we#ird`)).toEqual({
      pieceId: HANDLE,
      path: ["we#ird"],
    });
    expect(normalizeLLMFriendlyRef(`/${HANDLE}/draft#argument`)).toEqual({
      pieceId: HANDLE,
      path: ["draft#argument"],
    });
    expect(normalizeLLMFriendlyRef(`/${HANDLE}/draft#argument `)).toEqual({
      pieceId: HANDLE,
      path: ["draft#argument "],
    });
  });

  it("splits the suffix off a bare target the way it does off a reference", () => {
    // One reading for both spellings: the piece a bare id names is the piece
    // a reference names, so the selection written after it means the same.
    expect(splitArgumentSuffix("thermostat#argument")).toEqual({
      target: "thermostat",
      input: true,
    });
    expect(splitArgumentSuffix(`${HANDLE}#argument@user`)).toEqual({
      target: `${HANDLE}@user`,
      input: true,
    });
    expect(splitArgumentSuffix("thermostat")).toEqual({
      target: "thermostat",
      input: false,
    });
    expect(splitArgumentSuffix("thermostat#result")).toEqual({
      target: "thermostat",
      input: false,
    });
    expect(splitArgumentSuffix("thermostat#argument@user")).toEqual({
      target: "thermostat@user",
      input: true,
    });
    expect(() => splitArgumentSuffix("thermostat@user#argument")).toThrow(
      /piece segment/,
    );
    expect(() => splitArgumentSuffix("#argument")).toThrow(/piece handle/);
  });
});
