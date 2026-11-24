import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { consolePolicyReport } from "../../console/policy.ts";
import { DEFAULT_HARNESS_CHAT_POLICY } from "../../src/contracts/interactive-chat.ts";

const INPUT = {
  policy: DEFAULT_HARNESS_CHAT_POLICY,
  fabricSpace: "measurement",
  artifactRoot: "/console/runs",
};

describe("consolePolicyReport()", () => {
  it("returns the tools and profiles the policy names", () => {
    const report = consolePolicyReport(INPUT);

    expect(report.allowedToolIds).toEqual([
      ...DEFAULT_HARNESS_CHAT_POLICY.allowedToolIds,
    ]);
    expect(report.allowedSubagentProfiles).toEqual([
      ...DEFAULT_HARNESS_CHAT_POLICY.allowedSubagentProfiles,
    ]);
    expect(report.fabricSpace).toBe("measurement");
    expect(report.artifactRoot).toBe("/console/runs");
  });

  it("returns `null` for the prompt and the store a server was not given", () => {
    const report = consolePolicyReport(INPUT);

    expect(report.systemPromptSha256).toBeNull();
    expect(report.sessionDbPath).toBeNull();
  });

  it("returns the prompt's SHA-256 and never its text", () => {
    const report = consolePolicyReport({
      ...INPUT,
      systemPrompt: "abc",
      sessionDbPath: "/console/sessions.sqlite",
    });

    expect(report.systemPromptSha256).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(JSON.stringify(report)).not.toContain("abc");
    expect(report.sessionDbPath).toBe("/console/sessions.sqlite");
  });

  it("returns a digest over the prompt's UTF-8 bytes", () => {
    // Both digests are what `shasum -a 256` prints for the same text, so an
    // operator who takes one that way and pastes it into a cell spec gets a
    // match. A prompt outside ASCII is what tells the encodings apart.

    expect(consolePolicyReport({ ...INPUT, systemPrompt: "héllo" })).toEqual({
      ...consolePolicyReport(INPUT),
      systemPromptSha256:
        "3c48591d8d098a4538f5e013dfcf406e948eac4d3277b10bf614e295d6068179",
    });
  });

  it("returns different digests for prompts differing by one character", () => {
    const one = consolePolicyReport({ ...INPUT, systemPrompt: "abc" });
    const other = consolePolicyReport({ ...INPUT, systemPrompt: "abd" });

    expect(one.systemPromptSha256).not.toBe(other.systemPromptSha256);
  });
});
