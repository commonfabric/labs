/**
 * `profileSpaceRoot()` over a snapshot of one empty store, with no server:
 * what it refuses about its targets, and the row it reports for a profile
 * whose space it cannot open.
 */

import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import { getMemoryProtocolFlags } from "@commonfabric/memory/v2";
import { close, open } from "@commonfabric/memory/v2/engine";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import type { SpaceConfig } from "../lib/piece.ts";
import {
  profileSpaceRoot,
  type ProfileSpaceRootConfig,
} from "../lib/profile-space-root.ts";

const PROFILE_SPACE = "did:key:z6MkProfileSpaceRootTarget";
const PROFILE = `//${PROFILE_SPACE}/of:fid1:profile`;

describe("profile-space-root-snapshot", () => {
  let snapshot: string;
  // The spaces the run asked the server about, and asked to open.
  let asked: string[];
  let opened: string[];

  const config = (
    extra: Partial<ProfileSpaceRootConfig> = {},
  ): ProfileSpaceRootConfig => ({
    apiUrl: "http://127.0.0.1:8000",
    identity: "/unread.key",
    snapshot,
    ...extra,
  });

  const deps = {
    serverFlags: (spaceConfig: SpaceConfig) => {
      asked.push(spaceConfig.space);
      return Promise.resolve({
        ...getMemoryProtocolFlags(),
        serverExecution: false,
      });
    },
    load: (spaceConfig: SpaceConfig) => {
      opened.push(spaceConfig.space);
      return Promise.reject(new Error("the connection was refused"));
    },
  };

  beforeEach(async () => {
    asked = [];
    opened = [];
    snapshot = await Deno.makeTempDir({ prefix: "cf-repair-root-snapshot-" });
    const store = `${snapshot}/did:key:z6MkProfileSpaceRootHome.sqlite`;
    close(await open({ url: toFileUrl(store) }));
  });

  afterEach(async () => {
    await Deno.remove(snapshot, { recursive: true });
  });

  it("throws naming a snapshot directory that holds no space database, asking the server nothing", async () => {
    const empty = await Deno.makeTempDir({ prefix: "cf-repair-root-empty-" });
    try {
      await expect(profileSpaceRoot(config({ snapshot: empty }), deps))
        .rejects.toThrow(`No space databases under ${empty}`);
    } finally {
      await Deno.remove(empty);
    }
    expect(asked).toEqual([]);
  });

  it("throws for a named address that is not a full profile address, asking the server nothing", async () => {
    for (
      const cell of [
        `${PROFILE}/name`,
        `//${PROFILE_SPACE}/computed:x`,
        `${PROFILE}@user`,
      ]
    ) {
      await expect(profileSpaceRoot(config({ cells: [cell] }), deps)).rejects
        .toThrow(
          "A profile to repair is named by a full cell address with a space DID, no member or path, and space scope.",
        );
    }
    expect(asked).toEqual([]);
    expect(opened).toEqual([]);
  });

  it("reports a profile whose space it cannot open as failed, with the reason, and changes nothing", async () => {
    const report = await profileSpaceRoot(config({ cells: [PROFILE] }), deps);
    expect(asked).toEqual([PROFILE_SPACE]);
    expect(opened).toEqual([PROFILE_SPACE]);
    expect(report.applied).toBe(false);
    expect(report.rows).toEqual([{
      named: { space: PROFILE_SPACE, id: "of:fid1:profile" },
      status: "failed",
      action: "none",
      reason: "the connection was refused",
    }]);
    expect(report.summary).toEqual({ failed: 1 });
  });
});
