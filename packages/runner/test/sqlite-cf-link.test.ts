// Tests for the _cf_link codec (spec docs/specs/sqlite-builtin/02).
// Encodes a cell reference to an absolute sigil-link string for storage in a
// TEXT column whose name ends in `_cf_link`, and decodes it back to a live Cell.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { areNormalizedLinksSame } from "../src/link-utils.ts";

import {
  decodeCfLinkValue,
  encodeCfLinkValue,
  isCfLinkColumn,
} from "../src/builtins/sqlite/cf-link.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("isCfLinkColumn", () => {
  it("matches only names ending in _cf_link", () => {
    expect(isCfLinkColumn("author_cf_link")).toBe(true);
    expect(isCfLinkColumn("x_cf_link")).toBe(true);
    expect(isCfLinkColumn("author")).toBe(false);
    expect(isCfLinkColumn("cf_link")).toBe(false); // needs a prefix before _cf_link
    expect(isCfLinkColumn("_cf_linked")).toBe(false);
  });
});

describe("_cf_link codec", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("round-trips a cell through encode/decode", () => {
    const cell = runtime.getCell<{ name: string }>(
      space,
      "cf-link-roundtrip",
      undefined,
      tx,
    );
    const encoded = encodeCfLinkValue(cell);
    expect(typeof encoded).toBe("string");

    // Stored string is an absolute sigil link: includes id and space.
    const parsed = JSON.parse(encoded);
    expect(parsed["/"]?.["link@1"]?.id).toBeDefined();
    expect(parsed["/"]?.["link@1"]?.space).toBe(space);

    const decoded = decodeCfLinkValue(encoded, runtime, undefined, tx);
    expect(decoded).not.toBeNull();
    expect(
      areNormalizedLinksSame(
        decoded!.getAsNormalizedFullLink(),
        cell.getAsNormalizedFullLink(),
      ),
    ).toBe(true);
  });

  it("decodes NULL to null", () => {
    expect(decodeCfLinkValue(null, runtime, undefined, tx)).toBeNull();
  });

  it("throws when encoding a non-cell value", () => {
    expect(() => encodeCfLinkValue("not a cell")).toThrow();
    expect(() => encodeCfLinkValue(42)).toThrow();
    expect(() => encodeCfLinkValue({ plain: "object" })).toThrow();
  });

  it("throws when decoding a non-string, non-null value", () => {
    expect(() => decodeCfLinkValue(42, runtime, undefined, tx)).toThrow();
  });

  it("throws when decoding malformed or non-sigil strings", () => {
    expect(() => decodeCfLinkValue("not json", runtime, undefined, tx))
      .toThrow();
    expect(() => decodeCfLinkValue('{"foo":1}', runtime, undefined, tx))
      .toThrow();
  });
});
