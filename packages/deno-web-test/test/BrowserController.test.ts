/**
 * What `BrowserController` does when it is asked about a page it has not
 * loaded. The methods that drive a test file each reach for the page the
 * controller opened in `load()`, and a caller that never loaded one gets a
 * message saying so rather than a failure inside astral.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { BrowserController } from "../browser.ts";
import { applyDefaults } from "../config.ts";
import { Manifest } from "../manifest.ts";

// A manifest naming directories nothing here reaches: the controller holds it
// for its configuration and its profile directory, and neither is read before
// a page is loaded.
function unloadedController(): BrowserController {
  return new BrowserController(
    new Manifest("/nowhere", [], "/nowhere", applyDefaults({})),
    0,
  );
}

describe("BrowserController", () => {
  describe("instance members", () => {
    describe("getTestCount()", () => {
      it("throws when no page has been loaded", async () => {
        await expect(unloadedController().getTestCount()).rejects.toThrow(
          "No page loaded.",
        );
      });
    });

    describe("runTest()", () => {
      it("throws when no page has been loaded", async () => {
        await expect(unloadedController().runTest(0)).rejects.toThrow(
          "No page loaded.",
        );
      });
    });
  });
});
