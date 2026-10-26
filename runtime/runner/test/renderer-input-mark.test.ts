/**
 * Plan B ($value provenance): a renderer keystroke write is marked so the
 * scheduler can recognize it at the storage-notification choke point (via
 * notification.source) and shape the resulting subscriber wake. The mark must
 * survive to commit (unlike the blind-write mark, which is cleared), and must be
 * found on any tx layer, since the notification's source is an inner layer.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  isRendererInputTx,
  markRendererInputTx,
} from "../src/storage/reactivity-log.ts";

describe("renderer-input tx mark", () => {
  it("marks a tx and every inner layer, and recognizes them", () => {
    const inner = {};
    const tx = { tx: inner };
    expect(isRendererInputTx(tx)).toBe(false);
    expect(isRendererInputTx(inner)).toBe(false);
    markRendererInputTx(tx);
    // The commit notification's source is an inner storage-tx layer, so the mark
    // must be found there too.
    expect(isRendererInputTx(tx)).toBe(true);
    expect(isRendererInputTx(inner)).toBe(true);
  });

  it("leaves an unmarked tx unrecognized", () => {
    expect(isRendererInputTx({})).toBe(false);
    expect(isRendererInputTx({ tx: {} })).toBe(false);
  });
});
