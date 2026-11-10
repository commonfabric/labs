import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  CHIP_UI,
  FRAMEWORK_RESULT_KEYS,
  FS,
  NAME,
  TESTS,
  TILE_UI,
  TYPE,
  UI,
  VIEWS,
} from "../src/framework-result-keys.ts";

describe("framework-result-keys", () => {
  it("spells each reserved key", () => {
    // Pinned as text rather than against the constant that produced it. A
    // consumer outside this workspace holds the spelling as a literal — a host
    // probing `$VIEWS` on a result it was handed has no import to follow — so
    // the text is the contract, and a rename is a break for it.
    expect([TYPE, NAME, UI, TILE_UI, CHIP_UI, FS, TESTS, VIEWS]).toEqual([
      "$TYPE",
      "$NAME",
      "$UI",
      "$TILE_UI",
      "$CHIP_UI",
      "$FS",
      "$TESTS",
      "$VIEWS",
    ]);
  });

  it("enumerates every reserved key", () => {
    // The list is what the transformer polices and what a sanitizer is handed
    // as the keys that are the framework's to name, so a key that exists and
    // is absent from it is unenforced rather than unreserved.
    expect([...FRAMEWORK_RESULT_KEYS]).toEqual([
      "$TYPE",
      "$NAME",
      "$UI",
      "$TILE_UI",
      "$CHIP_UI",
      "$FS",
      "$TESTS",
      "$VIEWS",
    ]);
  });
});
