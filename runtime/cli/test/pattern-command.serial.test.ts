/**
 * Drives the `cf pattern` commands against a fake pattern index, compiling
 * with a runtime over emulated storage. Serial, since they set
 * `Deno.exitCode` and write refusals to `console.error`, and the model is
 * answered from the LLM client's process-wide mock catalog.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { stub } from "@std/testing/mock";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity, issueDelegation } from "@commonfabric/identity";
import {
  addMockObjectResponse,
  enableMockMode,
  resetMockMode,
} from "@commonfabric/llm";
import type {
  PatternIndexLineage,
  PatternIndexLink,
  PatternIndexProgram,
  PatternIndexVersionSummary,
} from "@commonfabric/pattern-index/client";
import type { PatternIndexFetch } from "@commonfabric/pattern-index/http-fetch";
import { PatternIndexStore } from "@commonfabric/pattern-index/store";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { delegationsCause } from "../../runner/src/runtime.ts";
import {
  history,
  link,
  type PublishCommandDeps,
  publishNamed,
  rollback,
  share,
  stable,
  unpublish,
  unshare,
} from "../commands/pattern.ts";
import type { IndexDeps } from "../commands/pattern-index.ts";
import { entrySlot } from "../lib/pattern-versions.ts";
import type { ListedProfile } from "../lib/profile.ts";
import { FakePatternIndex } from "../../pattern-index/test/fake-pattern-index.ts";

const BASE = "https://index.test";
const ADDRESS = "742 Evergreen Terrace";

const SOURCE = `/**
 * Says where the household lives.
 *
 * @hashtags #home
 */
import { pattern } from "commonfabric";
const HOME = "${ADDRESS}";
export default pattern<Record<string, never>, { home: string }>(() => ({
  home: HOME,
}));
`;

const GENERALIZED = `/**
 * Says where the household lives.
 *
 * @hashtags #home
 */
import { pattern } from "commonfabric";
export default pattern<{ home: string }, { home: string }>(({ home }) => ({
  home,
}));
`;

const PRIVACY_PROMPT = {
  name: "privacy",
  kind: "gate",
  promptVersion: "v1",
  prompt: "PRIVACY",
  outputSchema: { type: "object" },
};

/** A version summary of lineage `lin-1`. */
const summary = (
  seq: number,
  more: Partial<PatternIndexVersionSummary> = {},
): PatternIndexVersionSummary => ({
  versionId: `ver-${seq}`,
  lineageId: "lin-1",
  seq,
  patternId: `pat-${seq}`,
  createdAt: `2026-11-16T10:0${seq}:00.000Z`,
  description: "Says where the household lives.",
  hashtags: [],
  origin: "self",
  visibility: "private",
  share: "none",
  head: false,
  ...more,
});

/**
 * The owner-only lineage calls of a pattern index, answering for a member
 * holding `lineages`, all of them versions v1 and v2 (the head) of `lin-1`
 * with the sources in `programs`, and refusing a caller who is not a member.
 * Every other call goes to `rest`.
 */
class FakeLineages {
  readonly calls: { fn: string; body: Record<string, unknown> }[] = [];
  lineages: PatternIndexLineage[] = [];
  programs: Record<string, PatternIndexProgram> = {};
  member = true;

  /** Whether the lineage is published under the member's name. */
  published = false;

  /** What `listVersions` answers for `lin-1`, newest first. */
  versions: PatternIndexVersionSummary[] = [
    summary(2, { head: true }),
    summary(1),
  ];

  /** What each pattern link resolves to; any other ref is a 404. */
  links: Record<string, PatternIndexLink> = {};

  /** Whether `shareVersion` refuses as not the newest (409). */
  notNewest = false;

  readonly #rest: PatternIndexFetch;

  constructor(rest: PatternIndexFetch) {
    this.#rest = rest;
  }

  /** Keeps `lin-1` under `slot`. */
  keep(slot: string): void {
    this.lineages = [{
      lineageId: "lin-1",
      slot,
      origin: "self",
      pseudonym: "a-xyz",
      description: "Says where the household lives.",
      head: summary(2, { head: true }),
      versions: 2,
      sharedVersions: 0,
      tier: 0,
    }];
  }

  readonly fetchFn: PatternIndexFetch = async (input, init) => {
    const fn = String(input).split("/").at(-1)!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    // A pattern link is an owner's lineage read; a pattern id is the index's.
    const answer = fn === "getPattern" && body.ref === undefined
      ? undefined
      : this.#answer(fn);
    if (answer === undefined) return await this.#rest(input, init);
    if (!this.member) {
      return Response.json({ error: "not a member" }, { status: 403 });
    }
    this.calls.push({ fn, body });
    return answer(body);
  };

  #answer(
    fn: string,
  ): ((body: Record<string, unknown>) => Response) | undefined {
    const answer = this.#value(fn);
    return answer === undefined ? undefined : (body) => {
      const value = answer(body);
      if (value === undefined) {
        return Response.json({ error: "pattern not found" }, {
          status: 404,
        });
      }
      return value instanceof Response ? value : Response.json(value);
    };
  }

  #value(
    fn: string,
  ):
    | ((body: Record<string, unknown>) => Response | object | undefined)
    | undefined {
    switch (fn) {
      case "getPattern":
        return ({ ref }) => {
          const link = this.links[String(ref)];
          return link === undefined ? undefined : {
            patternId: `pat-${link.number}`,
            createdAt: "2026-11-16T10:00:00.000Z",
            description: "Says where the household lives.",
            hashtags: [],
            dependencies: [],
            link,
          };
        };
      case "shareVersion":
        return ({ versionId }) =>
          this.notNewest
            ? Response.json({ code: "not_newest" }, { status: 409 })
            : {
              versionId,
              patternId: "pat-2",
              visibility: "public",
              share: "shared",
              listing: "passed",
              shared: 2,
              changed: true,
            };
      case "listLineages":
        return () => ({ lineages: this.lineages });
      case "listVersions":
        return () => ({ lineageId: "lin-1", versions: this.versions });
      case "getVersion":
        return ({ versionId }) => ({
          ...summary(Number(String(versionId).slice(4))),
          keywords: [],
          dependencies: [],
          program: this.programs[String(versionId)],
        });
      case "rollback":
        return () => ({ patternId: "pat-1", created: true, seq: 3 });
      case "unshareLineage":
        return () => ({ lineageId: "lin-1", unshared: true, changed: true });
      case "unpublishLineage":
        return () => ({
          lineageId: "lin-1",
          published: null,
          changed: this.published,
        });
      case "publishLineage":
        return ({ profile }) => ({
          lineageId: "lin-1",
          published: { profile, since: "2026-11-16" },
        });
    }
  }
}

describe("pattern", () => {
  let dir: string;
  let entry: string;
  let keyPath: string;
  let signer: Identity;
  let index: FakePatternIndex;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let disposed: number;
  let rendered: { value: unknown; json?: boolean }[];
  let savedExitCode: number;
  let errors: string[];
  let stderr: { restore(): void };
  let store: PatternIndexStore;
  let lineages: FakeLineages;

  beforeEach(async () => {
    savedExitCode = Deno.exitCode;
    dir = await Deno.makeTempDir({ prefix: "cf-pattern-publish-" });
    entry = join(dir, "home.tsx");
    await Deno.writeTextFile(entry, SOURCE);
    keyPath = join(dir, "me.key");
    const pkcs8 = await Identity.generatePkcs8();
    await Deno.writeFile(keyPath, pkcs8);
    signer = await Identity.fromPkcs8(pkcs8);
    index = new FakePatternIndex({ privacyPrompt: PRIVACY_PROMPT });
    index.admit(signer.did(), "p-me");
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    disposed = 0;
    rendered = [];
    errors = [];
    stderr = stub(console, "error", (...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    store = new PatternIndexStore(join(dir, "store"));
    lineages = new FakeLineages(index.fetchFn);
  });

  afterEach(async () => {
    stderr.restore();
    Deno.exitCode = savedExitCode;
    resetMockMode();
    await runtime.dispose();
    await storageManager.close();
    await Deno.remove(dir, { recursive: true });
  });

  const options = (extra: Record<string, unknown> = {}) => ({
    identity: keyPath,
    apiUrl: "http://toolshed.test",
    space: signer.did(),
    patternIndexUrl: BASE,
    ...extra,
  });

  const deps = (extra: PublishCommandDeps = {}): PublishCommandDeps => ({
    fetchFn: index.fetchFn,
    store,
    loadPieces: () =>
      Promise.resolve({
        runtime,
        getSpace: () => signer.did(),
        dispose: () => {
          disposed++;
          return Promise.resolve();
        },
      }),
    render: (value, options) => {
      rendered.push({ value, json: options?.json });
    },
    ...extra,
  });

  /** The deps of the owner-only commands, answered by `lineages`. */
  const ownerDeps = (): IndexDeps => ({
    fetchFn: lineages.fetchFn,
    store,
    render: (value, options) => {
      rendered.push({ value, json: options?.json });
    },
  });

  /** The slot the commands find the entry's lineage under. */
  const entrysSlot = () => entrySlot(entry, { pathKey: () => store.slotKey() });

  /** Answers the next privacy check, or the next rewrite, with `object`. */
  const answer = (
    asked: string[],
    check: boolean,
    object: Record<string, unknown>,
    meanwhile?: () => void,
  ) =>
    addMockObjectResponse((request) => {
      if ((request.system === "PRIVACY") !== check) return false;
      asked.push(check ? "check" : "rewrite");
      meanwhile?.();
      return true;
    }, { object });

  /** Scripts a failing check, a rewrite, and a passing check of it. */
  const scriptRewrite = (asked: string[], meanwhile?: () => void) => {
    enableMockMode();
    answer(asked, true, {
      verdict: "fail",
      findings: [{
        file: "/home.tsx",
        line: 7,
        category: "address_or_location",
        why: "a street address in a constant",
      }],
      generalizations: [],
    });
    answer(asked, true, { verdict: "pass", findings: [], generalizations: [] });
    answer(asked, false, {
      files: [{ name: "/home.tsx", contents: GENERALIZED }],
      changes: [{ file: "/home.tsx", category: "lift_constant_to_argument" }],
    }, meanwhile);
  };

  describe("share()", () => {
    it("publishes the program compiled from the entry file, prints what it did, and closes the connection", async () => {
      await share(options({ skipLocalCheck: true }), entry, deps());

      const published = index.calls.find((call) =>
        call.fn === "publishPattern"
      );
      expect(published?.body.patternId).toEqual(expect.any(String));
      expect(JSON.stringify(published?.body)).toContain(ADDRESS);
      expect(published?.body.slot).toBe(await entrysSlot());
      const text = String(rendered[0].value);
      expect(text).toContain(
        "Skipped the local privacy check: --skip-local-check.",
      );
      expect(text).toContain(
        `Shared ${published?.body.patternId} as p-me (v1).`,
      );
      expect(Deno.exitCode).toBe(savedExitCode);
      expect(disposed).toBe(1);
    });

    it("sends standalone for --standalone, a part for --part, and nothing for neither", async () => {
      await share(
        options({ skipLocalCheck: true, standalone: true }),
        entry,
        deps(),
      );
      await share(options({ skipLocalCheck: true, part: true }), entry, deps());
      await share(options({ skipLocalCheck: true }), entry, deps());

      const sent = index.calls.filter((call) => call.fn === "publishPattern")
        .map((call) =>
          Object.hasOwn(call.body, "standalone") ? call.body.standalone : "-"
        );
      expect(sent).toEqual([true, false, "-"]);
    });

    it("shares the version it kept on beta, by link only, and asks for no listing", async () => {
      await share(options({ skipLocalCheck: true }), entry, deps());

      const published = index.calls.find((call) =>
        call.fn === "publishPattern"
      );
      expect(index.calls.find((call) => call.fn === "shareVersion")?.body)
        .toEqual({ versionId: expect.any(String), channel: "beta" });
      expect(index.calls.some((call) => call.fn === "requestListing")).toBe(
        false,
      );
      expect(
        index.publications.get(String(published?.body.patternId))?.channel,
      ).toBe("beta");
      expect(String(rendered[0].value)).toContain(
        "Beta: once the index's privacy check passes, it is reachable by its link (cf pattern link --beta); nobody finds it until cf pattern stable.",
      );
    });

    it("records what it published from the entry file in the store for the index, under the state directory", async () => {
      const saved = Deno.env.get("CF_PATTERN_INDEX_HOME");
      Deno.env.set("CF_PATTERN_INDEX_HOME", join(dir, "home"));
      try {
        const { store: _store, ...withoutStore } = deps();
        await share(options({ skipLocalCheck: true }), entry, withoutStore);
      } finally {
        if (saved === undefined) Deno.env.delete("CF_PATTERN_INDEX_HOME");
        else Deno.env.set("CF_PATTERN_INDEX_HOME", saved);
      }

      const published = index.calls.find((call) =>
        call.fn === "publishPattern"
      );
      expect(
        await new PatternIndexStore(join(dir, "home", "index.test"))
          .lastPublished(entry),
      ).toBe(published?.body.patternId);
    });

    it("asks the toolshed's model, keeps the source as a version, and writes the compiled rewrite over files git cannot restore", async () => {
      const asked: string[] = [];
      scriptRewrite(asked);

      await share(
        options({ json: true }),
        entry,
        deps({ uncommitted: (paths) => Promise.resolve([...paths]) }),
      );

      expect(asked).toEqual(["check", "rewrite", "check"]);
      expect(rendered[0].json).toBe(true);
      expect(rendered[0].value).toMatchObject({
        outcome: "shared",
        version: 2,
        localCheck: { status: "rewritten", applied: true, originalVersion: 1 },
      });
      expect(Deno.exitCode).toBe(savedExitCode);
      const published = index.calls.filter((call) =>
        call.fn === "publishPattern"
      );
      expect(published.map((call) =>
        JSON.stringify(call.body).includes(
          ADDRESS,
        )
      )).toEqual([true, false]);
      expect(await Deno.readTextFile(entry)).toBe(GENERALIZED);
      expect(disposed).toBe(1);
    });

    it("exits 1 sharing nothing when the entry is edited while it is checked", async () => {
      const asked: string[] = [];
      const edited = `${SOURCE}// edited meanwhile\n`;
      scriptRewrite(asked, () => Deno.writeTextFileSync(entry, edited));

      await share(
        options({ json: true }),
        entry,
        deps({ uncommitted: () => Promise.resolve([]) }),
      );

      expect(rendered[0].value).toMatchObject({
        outcome: "blocked",
        localCheck: { status: "rewritten", applied: false },
      });
      expect(JSON.stringify(rendered[0].value)).toContain(
        "changed on disk while it was being checked",
      );
      expect(Deno.exitCode).toBe(1);
      expect(index.calls.some((call) => call.fn === "publishPattern")).toBe(
        false,
      );
      expect(await Deno.readTextFile(entry)).toBe(edited);
      expect(disposed).toBe(1);
    });
  });

  describe("publishNamed()", () => {
    let profileKey: Identity;
    let profile: ListedProfile;

    beforeEach(async () => {
      profileKey = await Identity.generate();
      profile = {
        name: "Sam Lee",
        picture: undefined,
        pictureByOwner: false,
        avatar: "",
        avatarByOwner: false,
        space: profileKey.did(),
        id: "fid1:profile",
        address: "",
        current: true,
      };
    });

    /** Records in Home the delegation the profile space issued the signer. */
    const recordProfileDelegation = async () => {
      const delegation = await issueDelegation(profileKey, {
        aud: signer.did(),
        sub: profileKey.did(),
        cmd: "/memory",
        pol: [],
      });
      const { error } = await runtime.editWithRetry((tx) => {
        runtime.getCell(
          signer.did(),
          delegationsCause(profileKey.did()),
          undefined,
          tx,
        ).set({ delegations: [new FabricBytes(delegation.bytes)] });
      });
      expect(error).toBeUndefined();
    };

    const namedDeps = () => ({
      ...deps({ fetchFn: lineages.fetchFn }),
      listProfiles: () => Promise.resolve([profile]),
    });

    it("shares the pattern, then names the person on the lineage it was kept in, printing both", async () => {
      await recordProfileDelegation();
      lineages.keep(await entrysSlot());

      await publishNamed(
        options({ skipLocalCheck: true, as: "Sam Lee" }),
        entry,
        namedDeps(),
      );

      expect(lineages.calls.find((call) => call.fn === "publishLineage")?.body)
        .toEqual({
          lineageId: "lin-1",
          profile: { space: profileKey.did(), piece: "fid1:profile" },
          displayName: "Sam Lee",
          profileProof: [expect.any(String)],
        });
      expect(rendered.map((r) => r.json)).toEqual([undefined, undefined]);
      expect(String(rendered[0].value)).toContain("as p-me (v1).");
      expect(lineages.calls.find((call) => call.fn === "shareVersion")?.body)
        .toEqual({ versionId: expect.any(String), channel: "stable" });
      expect(rendered[1].value).toBe(
        `Published under "Sam Lee"; cf pattern unpublish ${entry} stops showing it.`,
      );
      expect(errors).toEqual([]);
      expect(Deno.exitCode).toBe(savedExitCode);
      expect(disposed).toBe(2);
    });

    it("prints the share's report with what was named as one JSON value with --json", async () => {
      await recordProfileDelegation();
      lineages.keep(await entrysSlot());

      await publishNamed(
        options({ skipLocalCheck: true, as: "Sam Lee", json: true }),
        entry,
        namedDeps(),
      );

      expect(rendered).toEqual([{
        value: expect.objectContaining({
          outcome: "shared",
          named: expect.stringContaining('Published under "Sam Lee"'),
        }),
        json: true,
      }]);
    });

    it("exits 1 saying it shared but named nothing when the index keeps no lineage for the entry", async () => {
      await recordProfileDelegation();

      await publishNamed(
        options({ skipLocalCheck: true, as: "Sam Lee" }),
        entry,
        namedDeps(),
      );

      expect(index.calls.some((call) => call.fn === "publishPattern")).toBe(
        true,
      );
      expect(lineages.calls.some((call) => call.fn === "publishLineage"))
        .toBe(false);
      expect(rendered[1].value).toBe(
        `Shared, but not published under your name: the index keeps no versions of ${entry}`,
      );
      expect(Deno.exitCode).toBe(1);
    });

    it("exits 1 naming and sharing nothing when --as does not repeat the profile's name", async () => {
      await recordProfileDelegation();

      await publishNamed(
        options({ skipLocalCheck: true, as: "Sam" }),
        entry,
        namedDeps(),
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(
        'Publishing shows "Sam Lee" as this pattern\'s author',
      );
      expect(errors[0]).toContain('run this again with --as "Sam Lee".');
      expect(index.calls).toEqual([]);
      expect(rendered).toEqual([]);
      expect(Deno.exitCode).toBe(1);
    });

    it("exits 1 sharing nothing for a profile that holds no delegation to the identity", async () => {
      await publishNamed(
        options({ skipLocalCheck: true, as: "Sam Lee" }),
        entry,
        namedDeps(),
      );

      expect(errors).toEqual([
        expect.stringContaining("holds no delegation to this identity"),
      ]);
      expect(errors[0]).toMatch(/ Nothing was published\.$/);
      expect(index.calls).toEqual([]);
      expect(Deno.exitCode).toBe(1);
      expect(disposed).toBe(1);
    });

    it("throws a failure to list the profiles as it is, sharing nothing", async () => {
      await expect(publishNamed(
        options({ skipLocalCheck: true, as: "Sam Lee" }),
        entry,
        {
          ...namedDeps(),
          listProfiles: () => Promise.reject(new Error("Home is unreadable")),
        },
      )).rejects.toThrow("Home is unreadable");
      expect(errors).toEqual([]);
      expect(index.calls).toEqual([]);
      expect(Deno.exitCode).toBe(savedExitCode);
    });
  });

  describe("history()", () => {
    it("prints the entry's kept versions, newest first, marking the current one", async () => {
      lineages.keep(await entrysSlot());

      await history(options(), entry, ownerDeps());

      expect(String(rendered[0].value).split("\n")).toEqual([
        `Versions of ${entry}, newest first:`,
        "  v2    2026-11-16 10:02  private  (current)",
        "  v1    2026-11-16 10:01  private",
        `Restore one with: cf pattern rollback ${entry} <version>`,
      ]);
      expect(Deno.exitCode).toBe(savedExitCode);
    });

    it("prints every kept lineage without an entry file, as JSON with --json", async () => {
      lineages.keep(await entrysSlot());

      await history(options({ json: true }), undefined, ownerDeps());

      expect(rendered).toEqual([{ value: lineages.lineages, json: true }]);
      expect(lineages.calls.map((call) => call.fn)).toEqual(["listLineages"]);
    });

    it("exits 1 saying no versions are kept of an entry the index keeps none of", async () => {
      await history(options(), entry, ownerDeps());

      expect(errors).toEqual([
        expect.stringContaining(`No versions of ${entry} are kept yet`),
      ]);
      expect(rendered).toEqual([]);
      expect(Deno.exitCode).toBe(1);
    });

    it("throws what to do for an identity the index does not know, printing nothing", async () => {
      lineages.member = false;

      await expect(history(options(), entry, ownerDeps())).rejects.toThrow(
        "join with your invite link",
      );
      expect(rendered).toEqual([]);
      expect(errors).toEqual([]);
      expect(Deno.exitCode).toBe(savedExitCode);
    });
  });

  describe("rollback()", () => {
    beforeEach(async () => {
      lineages.keep(await entrysSlot());
      lineages.programs = {
        "ver-1": {
          main: "/home.tsx",
          files: [{ name: "/home.tsx", contents: GENERALIZED }],
        },
        "ver-2": {
          main: "/home.tsx",
          files: [{ name: "/home.tsx", contents: SOURCE }],
        },
      };
    });

    it("writes the version's files over the entry, makes it the newest version, and prints what it did", async () => {
      await rollback(options(), entry, "1", ownerDeps());

      expect(await Deno.readTextFile(entry)).toBe(GENERALIZED);
      expect(lineages.calls.find((call) => call.fn === "rollback")?.body)
        .toEqual({ lineageId: "lin-1", toVersionId: "ver-1" });
      expect(String(rendered[0].value)).toMatch(
        new RegExp(`^Restored v1 of ${entry} as v3, writing `),
      );
      expect(Deno.exitCode).toBe(savedExitCode);
    });

    it("exits 1 writing nothing over edits no version keeps, and writes over them with --force", async () => {
      await Deno.writeTextFile(entry, "edited\n");

      await rollback(options(), entry, "1", ownerDeps());

      expect(errors).toEqual([
        expect.stringContaining("edits that no version keeps"),
      ]);
      expect(await Deno.readTextFile(entry)).toBe("edited\n");
      expect(lineages.calls.some((call) => call.fn === "rollback")).toBe(
        false,
      );
      expect(Deno.exitCode).toBe(1);

      await rollback(options({ force: true }), entry, "1", ownerDeps());

      expect(await Deno.readTextFile(entry)).toBe(GENERALIZED);
    });
  });

  describe("unshare()", () => {
    it("stops sharing the entry's lineage and prints what that leaves readable", async () => {
      lineages.keep(await entrysSlot());

      await unshare(options(), entry, ownerDeps());

      expect(lineages.calls.find((call) => call.fn === "unshareLineage")?.body)
        .toEqual({ lineageId: "lin-1" });
      expect(rendered[0].value).toBe(
        `${entry} is no longer listed or shared on its own. Anyone holding the id of a version already shared can still open it; cf pattern share shares it again.`,
      );
    });

    it("exits 1 unsharing nothing for an entry the index keeps no versions of", async () => {
      await unshare(options({ json: true }), entry, ownerDeps());

      expect(errors).toEqual([`No versions of ${entry} are kept.`]);
      expect(lineages.calls.some((call) => call.fn === "unshareLineage"))
        .toBe(false);
      expect(rendered).toEqual([]);
      expect(Deno.exitCode).toBe(1);
    });
  });

  describe("stable()", () => {
    /** Keeps `lin-1` with `channels` and, optionally, a pending head. */
    const keepShared = async (
      channels: PatternIndexLineage["channels"],
      more: Partial<PatternIndexLineage> = {},
    ) => {
      lineages.keep(await entrysSlot());
      lineages.lineages = [{ ...lineages.lineages[0], channels, ...more }];
    };

    it("makes the version holding the newest shared number stable", async () => {
      await keepShared({ latest: 2, stable: 1, beta: 2 });
      lineages.versions = [
        summary(3, { head: true }),
        summary(2, { shared: { number: 2, stable: false } }),
        summary(1, { shared: { number: 1, stable: true } }),
      ];

      await stable(options(), entry, ownerDeps());

      expect(lineages.calls.find((call) => call.fn === "shareVersion")?.body)
        .toEqual({ versionId: "ver-2", channel: "stable" });
      expect(rendered[0].value).toBe(
        `Shared version #2 of ${entry} is stable: search and the catalog show it.`,
      );
      expect(Deno.exitCode).toBe(savedExitCode);
    });

    it("makes a share still being checked stable, never the older number before it", async () => {
      await keepShared(
        { latest: 1, beta: 1 },
        { head: summary(2, { head: true, share: "pending" }) },
      );

      await stable(options(), entry, ownerDeps());

      expect(lineages.calls.find((call) => call.fn === "shareVersion")?.body)
        .toEqual({ versionId: "ver-2", channel: "stable" });
      expect(rendered[0].value).toBe(
        `${entry} is still being checked; once it passes it is stable, and search and the catalog show it.`,
      );
    });

    it("asks nothing of the index when the newest shared number is stable already", async () => {
      await keepShared({ latest: 1, stable: 1, beta: 1 });

      await stable(options(), entry, ownerDeps());

      expect(lineages.calls.some((call) => call.fn === "shareVersion"))
        .toBe(false);
      expect(rendered[0].value).toBe(
        `Shared version #1 of ${entry} is stable already.`,
      );
    });

    for (
      const [name, channels, more, message] of [
        ["nothing of it is shared yet", {}, {}, "shares it on beta first"],
        [
          "it was unshared",
          { latest: 1, beta: 1 },
          { withdrawn: true },
          "is not shared",
        ],
        [
          "the newest number's version is no longer kept",
          { latest: 2, beta: 2 },
          {},
          "is no longer kept",
        ],
      ] as const
    ) {
      it(`exits 1 making nothing stable when ${name}`, async () => {
        await keepShared(channels, more);
        lineages.versions = [
          summary(1, { head: true, shared: { number: 1, stable: false } }),
        ];

        await stable(options(), entry, ownerDeps());

        expect(lineages.calls.some((call) => call.fn === "shareVersion"))
          .toBe(false);
        expect(errors.join("\n")).toContain(message);
        expect(Deno.exitCode).toBe(1);
      });
    }

    it("exits 1 saying to run it again when the index says a newer version was shared", async () => {
      await keepShared({ latest: 2, beta: 2 });
      lineages.versions = [
        summary(2, { head: true, shared: { number: 2, stable: false } }),
      ];
      lineages.notNewest = true;

      await stable(options(), entry, ownerDeps());

      expect(errors.join("\n")).toContain("run cf pattern stable again");
      expect(Deno.exitCode).toBe(1);
    });
  });

  describe("link()", () => {
    const linkTo = (
      ref: string,
      channel: PatternIndexLink["channel"],
      number: number,
    ): PatternIndexLink => ({
      ref,
      channel,
      number,
      stable: channel === "stable",
    });

    it("prints the stable link by the lineage's pseudonym, saying it does not name the person", async () => {
      lineages.keep(await entrysSlot());
      lineages.links = {
        "a-xyz": linkTo("a-xyz", "stable", 1),
        "a-xyz@beta": linkTo("a-xyz@beta", "beta", 2),
      };

      await link(options(), entry, ownerDeps());

      expect(rendered[0].value).toBe(
        `a-xyz: ${entry}, stable (shared version #1 now). It names the pattern, not you.`,
      );
    });

    it("says the link shows the person's name on a pattern published under it", async () => {
      lineages.keep(await entrysSlot());
      lineages.lineages = [{
        ...lineages.lineages[0],
        published: { profile: { space: "did:key:z6Mkp" }, since: "2026-11-16" },
      }];
      lineages.links = { "a-xyz": linkTo("a-xyz", "stable", 1) };

      await link(options(), entry, ownerDeps());

      expect(String(rendered[0].value)).toContain("It shows your name");
    });

    it("gives beta when nothing is stable yet, and beta with --beta", async () => {
      lineages.keep(await entrysSlot());
      lineages.links = { "a-xyz@beta": linkTo("a-xyz@beta", "beta", 2) };

      await link(options(), entry, ownerDeps());
      await link(options({ beta: true }), entry, ownerDeps());

      expect(rendered.map((r) => r.value)).toEqual([
        `a-xyz@beta: ${entry}, beta (shared version #2 now). It names the pattern, not you.`,
        `a-xyz@beta: ${entry}, beta (shared version #2 now). It names the pattern, not you.`,
      ]);
    });

    it("prints exactly one shared version with --number, never falling back", async () => {
      lineages.keep(await entrysSlot());
      lineages.links = {
        "a-xyz": linkTo("a-xyz", "stable", 2),
        "a-xyz@1": linkTo("a-xyz@1", "number", 1),
      };

      await link(options({ number: 1 }), entry, ownerDeps());
      await link(options({ number: 5 }), entry, ownerDeps());

      expect(rendered.map((r) => r.value)).toEqual([
        `a-xyz@1: ${entry}, exactly shared version #1. It names the pattern, not you.`,
      ]);
      expect(errors.join("\n")).toContain("has no shared version #5");
      expect(Deno.exitCode).toBe(1);
    });

    it("exits 1 printing no link when nothing of the entry is shared yet", async () => {
      lineages.keep(await entrysSlot());

      await link(options(), entry, ownerDeps());

      expect(rendered).toEqual([]);
      expect(errors.join("\n")).toContain("Nothing of");
      expect(Deno.exitCode).toBe(1);
    });
  });

  describe("unpublish()", () => {
    it("stops naming the person on the entry's lineage and prints the pseudonym it stays shared as", async () => {
      lineages.keep(await entrysSlot());
      lineages.published = true;

      await unpublish(options(), entry, ownerDeps());

      expect(
        lineages.calls.find((call) => call.fn === "unpublishLineage")?.body,
      ).toEqual({ lineageId: "lin-1" });
      expect(rendered[0].value).toBe(
        `${entry} is no longer shown under your name; it stays shared as a-xyz. Anyone who already saw both knows they are the same.`,
      );
    });

    it("prints that the entry was not published under the person's name, and the index's answer with --json", async () => {
      lineages.keep(await entrysSlot());

      await unpublish(options(), entry, ownerDeps());
      await unpublish(options({ json: true }), entry, ownerDeps());

      expect(rendered).toEqual([
        {
          value: `${entry} was not published under your name.`,
          json: undefined,
        },
        {
          value: { lineageId: "lin-1", published: null, changed: false },
          json: true,
        },
      ]);
    });

    it("exits 1 unpublishing nothing for an entry the index keeps no versions of", async () => {
      await unpublish(options(), entry, ownerDeps());

      expect(errors).toEqual([`No versions of ${entry} are kept.`]);
      expect(lineages.calls.some((call) => call.fn === "unpublishLineage"))
        .toBe(false);
      expect(Deno.exitCode).toBe(1);
    });
  });
});
