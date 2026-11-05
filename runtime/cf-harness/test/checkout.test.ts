/**
 * Finding the checkout a run defaults its documentation corpus and its skills
 * tree out of, and answering honestly when there is none.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, toFileUrl } from "@std/path";

import {
  harnessCheckoutRoot,
  harnessCheckoutRootFrom,
} from "../src/checkout.ts";

describe("harnessCheckoutRootFrom()", () => {
  it("finds the checkout above a module inside one", () => {
    const checkout = harnessCheckoutRoot();
    if (checkout === undefined) {
      throw new Error("these tests run out of a checkout");
    }
    // The walk goes up, so a module further down answers with the same root.
    expect(harnessCheckoutRootFrom(import.meta.url)).toEqual(checkout);
  });

  it("answers with nothing for a module that sits in no checkout", async () => {
    const directory = await Deno.makeTempDir({
      prefix: "cf-harness-no-checkout",
    });
    try {
      // A temporary directory carries none of the marker directories, and
      // neither does anything above it, so the walk reaches the filesystem
      // root and stops there rather than looping.
      const moduleUrl = toFileUrl(`${directory}/mod.ts`).href;
      expect(harnessCheckoutRootFrom(moduleUrl)).toBeUndefined();
      expect(dirname(directory)).not.toEqual(directory);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("answers with nothing for a module addressed by no file URL", () => {
    expect(harnessCheckoutRootFrom("https://example.test/mod.ts"))
      .toBeUndefined();
    expect(harnessCheckoutRootFrom("not a url")).toBeUndefined();
  });
});
