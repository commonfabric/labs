/** The agent runner's host-owned observation ceiling for an invitation. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type { ACL } from "@commonfabric/memory/acl";
import {
  cfcObservationFitsCeiling,
  type CfcObservationMaxConfidentiality,
} from "@commonfabric/runner/cfc";

import { agentRunObservationCeiling } from "../lib/agent-run-harness.ts";

const USER = "did:key:z6MkrZ1r5XBFZjBU34qyD8fueMbMRkKw17BZaq2ivKFjnz2z";
const OWNER = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const SPACE = "did:key:z6MkjcdxtxTiUWkPkPffhs8ENkCcJjuRCQPpJFb2xyzwHqEk";
const OTHER = "did:key:z6MkhrUcZnFPFZiMGnNd5JWuiD5qvzz9XdUVJ3uPCqXyYc3";
const personal = { type: CFC_ATOM_TYPE.User, subject: USER };
const invitation = { type: CFC_ATOM_TYPE.Space, id: SPACE };
const unrelated = { type: CFC_ATOM_TYPE.Space, id: OTHER };

describe("agent run observation ceiling", () => {
  it("admits an invitation shelf only while a fresh ACL grants the requester READ", async () => {
    let acl: ACL | null = { [OWNER]: "OWNER", [USER]: "READ" };
    const visited: string[] = [];
    const options = {
      identityKeyPath: "/unused.key",
      requester: USER,
      readSpaceAcl: (_host: string, space: string) => {
        visited.push(space);
        return Promise.resolve(acl);
      },
    };
    const ceiling = () =>
      agentRunObservationCeiling(
        options,
        "https://cloud.example",
        SPACE,
        undefined,
      );

    const granted = await ceiling();
    expect(cfcObservationFitsCeiling([personal], granted)).toBe(true);
    expect(cfcObservationFitsCeiling([invitation], granted)).toBe(true);
    expect(cfcObservationFitsCeiling([unrelated], granted)).toBe(false);

    acl = { [OWNER]: "OWNER" };
    const revoked = await ceiling();
    expect(cfcObservationFitsCeiling([personal], revoked)).toBe(true);
    expect(cfcObservationFitsCeiling([invitation], revoked)).toBe(false);
    expect(visited).toEqual([SPACE, SPACE]);
  });

  it("fails closed for outsider, absent, malformed, and unavailable ACLs", async () => {
    for (
      const acl of [
        { [OWNER]: "OWNER" },
        null,
        { [USER]: "READ" },
      ]
    ) {
      const ceiling = await agentRunObservationCeiling(
        {
          identityKeyPath: "/unused.key",
          requester: USER,
          readSpaceAcl: () => Promise.resolve(acl as ACL | null),
        },
        "https://cloud.example",
        SPACE,
        undefined,
      );
      expect(cfcObservationFitsCeiling([invitation], ceiling)).toBe(false);
    }
    const unavailable = await agentRunObservationCeiling(
      {
        identityKeyPath: "/unused.key",
        requester: USER,
        readSpaceAcl: () => Promise.reject(new Error("offline")),
      },
      "https://cloud.example",
      SPACE,
      undefined,
    );
    expect(cfcObservationFitsCeiling([invitation], unavailable)).toBe(false);
  });

  it("keeps a default ACL lookup failure personal-only", async () => {
    const reports: string[] = [];
    const ceiling = await agentRunObservationCeiling(
      {
        identityKeyPath:
          `/tmp/missing-agent-ceiling-${crypto.randomUUID()}.key`,
        requester: USER,
        report: (line) => reports.push(line),
      },
      "http://127.0.0.1:1",
      SPACE,
      undefined,
    );
    expect(cfcObservationFitsCeiling([personal], ceiling)).toBe(true);
    expect(cfcObservationFitsCeiling([invitation], ceiling)).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toContain("could not verify space membership");
  });

  it("lets an authored ceiling narrow but never expand host access", async () => {
    const options = {
      identityKeyPath: "/unused.key",
      requester: USER,
      readSpaceAcl: () =>
        Promise.resolve({ [OWNER]: "OWNER", [USER]: "READ" } as ACL),
    };
    const personalOnly: CfcObservationMaxConfidentiality = [personal];
    const narrow = await agentRunObservationCeiling(
      options,
      "https://cloud.example",
      SPACE,
      personalOnly,
    );
    expect(cfcObservationFitsCeiling([personal], narrow)).toBe(true);
    expect(cfcObservationFitsCeiling([invitation], narrow)).toBe(false);

    const authored: CfcObservationMaxConfidentiality = [invitation, unrelated];
    const bounded = await agentRunObservationCeiling(
      options,
      "https://cloud.example",
      SPACE,
      authored,
    );
    expect(cfcObservationFitsCeiling([invitation], bounded)).toBe(true);
    expect(cfcObservationFitsCeiling([unrelated], bounded)).toBe(false);
  });
});
