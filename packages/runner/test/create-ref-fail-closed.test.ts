import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";

import { CellImpl } from "../src/cell.ts";
import { createRef } from "../src/create-ref.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

describe("createRef fail-closed", () => {
  // Regression guard for createRef fail-closed behavior (audit S14).
  //
  // When a derivation input is a Reactive with no value (or a Cell with no
  // entityId), the id can no longer be derived from real inputs. The pre-fix
  // code substituted a random UUID, silently producing a non-deterministic id
  // where a stable, content-derived one was expected. createRef must fail
  // closed instead.

  it("throws when a Reactive derivation input has no value", async () => {
    const signer = await Identity.fromPassphrase("create ref fail closed");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    try {
      // A cell with no link yet, as the builder makes before a cell has an
      // identity.
      const reactiveNoValue = new CellImpl(runtime, undefined)
        .getAsReactiveProxy();

      expect(() => createRef({ ref: reactiveNoValue }, "cause")).toThrow(
        /cannot derive a stable id/,
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("derives a stable id from concrete inputs (unchanged)", () => {
    const a = createRef({ x: 1, y: "z" }, "cause");
    const b = createRef({ x: 1, y: "z" }, "cause");
    expect(a.taggedHashString).toEqual(b.taggedHashString);
  });

  it('derives distinct ids for the encodable forms `7` and `"7"`', () => {
    // An encodable form reaches the walk in place of the value it came from, so
    // a primitive form arrives past the point where a primitive INPUT is
    // handled. Stringifying one would make these two name one document.
    const asNumber = createRef({ held: { toEncodableForm: () => 7 } }, "cause");
    const asString = createRef(
      { held: { toEncodableForm: () => "7" } },
      "cause",
    );
    expect(asNumber.toString()).not.toBe(asString.toString());
  });

  it("still mints a fresh id when no cause is given (documented behavior)", () => {
    const a = createRef({ x: 1 });
    const b = createRef({ x: 1 });
    expect(a.taggedHashString).not.toEqual(b.taggedHashString);
  });
});
