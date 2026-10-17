/**
 * The address a person opens a named piece at, as the shell reads it back.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { urlToAppView } from "@commonfabric/navigation";

import { pieceUrl } from "../src/piece-url.ts";

/** A space created with a random key, which only its DID addresses. */
const CREATED_SPACE =
  "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

describe("pieceUrl()", () => {
  it("returns a space created by DID as the DID the shell reads", () => {
    const url = pieceUrl(
      "http://localhost:8000",
      CREATED_SPACE,
      "reading-list",
    );

    expect(url).toBe(`http://localhost:8000/${CREATED_SPACE}/reading-list`);
    expect(urlToAppView(new URL(url!))).toEqual({
      spaceDid: CREATED_SPACE,
      pieceSlug: "reading-list",
    });
  });

  it("returns a legacy space's name as the name the shell reads", () => {
    // A name is written as the shell writes one, so a name holding a
    // character a URL reserves reads back as that name rather than as its
    // escape.
    for (const name of ["my-space", "team:lunch"]) {
      const url = pieceUrl("http://localhost:8000/", name, "reading-list");

      expect(urlToAppView(new URL(url!))).toEqual({
        spaceName: name,
        pieceSlug: "reading-list",
      });
    }
  });

  it("returns an address under the path of the base it is given", () => {
    expect(
      pieceUrl("http://localhost:9901/pattern-pane/", "my-space", "notes"),
    ).toBe("http://localhost:9901/pattern-pane/my-space/notes");
  });

  it("returns no address for a name the shell would read as another piece", () => {
    // `/` and `\\` divide a path, an escaped character reads as its escape,
    // and a leading `@` is a mark: each address names something else.
    for (const name of ["team/lunch", "team\\lunch", "team lunch", "@team"]) {
      expect(pieceUrl("http://localhost:8000", name, "notes")).toBeUndefined();
    }
  });

  it("returns no address without a base URL or a space", () => {
    expect(pieceUrl("http://[invalid", "my-space", "notes")).toBeUndefined();
    expect(pieceUrl("http://localhost:8000", "", "notes")).toBeUndefined();
  });
});
