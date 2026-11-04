/**
 * Unit tests for the process's claim on the deployment it connects to: what
 * `claimProcessDeployment` accepts, what it refuses, what it declines to
 * record at all, and how it compares two spellings of one API URL. The claim
 * is a module-level string and nothing else, so each case resets it and calls
 * the function directly.
 *
 * The `loadPieces` cases drive the real thing, which claims ahead of the
 * identity it reads and the flags it fetches from the deployment: a refused
 * connection rejects with the limit's own message, and an API URL no
 * connection can be opened over rejects on the URL itself, leaving the claim
 * free for the corrected one. No runtime, socket, or server stands behind
 * either.
 */

import { expect } from "@std/expect";
import { beforeEach, describe, it } from "@std/testing/bdd";

import { loadPieces } from "../lib/piece.ts";
import {
  claimProcessDeployment,
  resetProcessDeployment,
} from "../lib/process-deployment.ts";

describe("process-deployment", () => {
  beforeEach(() => {
    resetProcessDeployment();
  });

  describe("claimProcessDeployment()", () => {
    it("accepts a second claim on the deployment already claimed", () => {
      claimProcessDeployment("https://toolshed.test");
      expect(() => claimProcessDeployment("https://toolshed.test/"))
        .not.toThrow();
    });

    it("throws naming both deployments given a different one", () => {
      claimProcessDeployment("https://first.test");
      expect(() => claimProcessDeployment("https://second.test")).toThrow(
        /`https:\/\/first\.test`.*`https:\/\/second\.test`/,
      );
    });

    it("accepts every spelling the CLI reads as one deployment", () => {
      claimProcessDeployment("https://toolshed.test/base/");
      expect(() => claimProcessDeployment("https://toolshed.test/base"))
        .not.toThrow();
      expect(() => claimProcessDeployment("https://toolshed.test/base?x=1"))
        .not.toThrow();
      expect(() => claimProcessDeployment("https://toolshed.test/base#top"))
        .not.toThrow();
    });

    it("says how to reach the refused deployment", () => {
      claimProcessDeployment("https://first.test");
      expect(() => claimProcessDeployment("https://second.test")).toThrow(
        "restarting is the deployment switch",
      );
    });

    it("declines an api url no connection can use, leaving the claim unmade", () => {
      claimProcessDeployment("not-a-url");
      claimProcessDeployment("localhost:8000");
      expect(() => claimProcessDeployment("https://first.test")).not.toThrow();
      expect(() => claimProcessDeployment("https://second.test")).toThrow();
    });
  });

  describe("loadPieces()", () => {
    // The claim is the connection's first act, ahead of the identity it reads
    // and the deployment it fetches flags from, so the rejection below is the
    // limit's own message rather than a failure of either.

    it("rejects a connection to a second deployment", async () => {
      claimProcessDeployment("https://first.test");
      await expect(loadPieces({
        apiUrl: "https://second.test",
        identity: "/nonexistent/second-deployment.key",
        space: "second-deployment",
      })).rejects.toThrow("one deployment per process");
    });

    it("leaves the claim unmade for an api url it cannot connect over", async () => {
      await expect(loadPieces({
        apiUrl: "localhost:8000",
        identity: "/nonexistent/unusable-api-url.key",
        space: "unusable-api-url",
      })).rejects.toThrow();
      expect(() => claimProcessDeployment("https://real.test")).not.toThrow();
      expect(() => claimProcessDeployment("https://other.test")).toThrow();
    });
  });
});
