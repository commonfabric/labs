import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  deployedPieceRef,
  type PatternIndexClient,
  PatternIndexError,
  type PatternIndexLineage,
  type PatternIndexPattern,
  type PatternIndexPublishRequest,
  type PatternIndexPublishResponse,
} from "@commonfabric/pattern-index/client";
import { PatternIndexStore } from "@commonfabric/pattern-index/store";
import { Identity } from "@commonfabric/identity";
import type { RuntimeProgram } from "@commonfabric/runner";
import {
  applyPieceSourceCommandAction,
  newPieceFromCommand,
  recordVersionInIndex,
} from "../commands/piece.ts";
import {
  type DeployedSource,
  entrySlot,
  recordDeployedVersion,
  type VersionDeps,
  versionLine,
  type VersionOutcome,
} from "../lib/pattern-versions.ts";
import { captureStderr } from "./utils.ts";

const SOURCE = `/**
 * Reminds the household to take the bins out on collection day.
 *
 * @hashtags #Chores
 * @keywords bin day
 */
export default () => "bins";
`;

const PROGRAM: RuntimeProgram = {
  main: "/bins.tsx",
  files: [{ name: "/bins.tsx", contents: SOURCE }],
};

const ROOT = (await Identity.fromPassphrase("pattern versions root")).did();

const RECORDED: PatternIndexPublishResponse = {
  patternId: "pat-1",
  created: true,
  versionId: "ver-1",
  lineageId: "lin-1",
  seq: 3,
  visibility: "private",
  share: "none",
  autoShare: "sharing_off",
};

/** A client recording what it was asked, answering from `answers`. */
const stubClient = (answers: {
  publish?: () => Promise<PatternIndexPublishResponse>;
  patterns?: Record<string, Partial<PatternIndexPattern>>;
  slots?: string[];
  keepsVersions?: boolean;
  selfBuilt?: boolean;
} = {}) => {
  const published: PatternIndexPublishRequest[] = [];
  const client: Pick<
    PatternIndexClient,
    "publishPattern" | "getPattern" | "listLineages" | "getSharingSettings"
  > = {
    getSharingSettings: () =>
      answers.keepsVersions === false
        ? Promise.reject(new PatternIndexError("getSharingSettings", 404))
        : Promise.resolve({
          enabled: true,
          selfBuilt: answers.selfBuilt ?? false,
          receivesAnonymous: true,
          updatedAt: null,
        }),
    listLineages: () =>
      Promise.resolve({
        lineages: (answers.slots ?? []).map((slot) =>
          ({ slot }) as PatternIndexLineage
        ),
      }),
    publishPattern: (request) => {
      published.push(request);
      return answers.publish?.() ?? Promise.resolve(RECORDED);
    },
    getPattern: ({ patternId }) => {
      const found = answers.patterns?.[patternId];
      return found === undefined
        ? Promise.reject(new PatternIndexError("getPattern", 404))
        : Promise.resolve(found as PatternIndexPattern);
    },
  };
  return { client, published };
};

describe("pattern-versions", () => {
  let dir: string;
  let entry: string;
  let store: PatternIndexStore;

  beforeEach(async () => {
    dir = await Deno.makeTempDir();
    entry = join(dir, "work", "bins.tsx");
    await Deno.mkdir(join(dir, "work"));
    await Deno.writeTextFile(entry, SOURCE);
    store = new PatternIndexStore(join(dir, "store"));
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  const joinIndex = () =>
    store.recordMembership({
      handle: "quiet-fox",
      role: "user",
      root: ROOT,
    });

  /** Deps whose client is `client`, counting how often it was opened. */
  const depsWith = (
    client: Pick<
      PatternIndexClient,
      "publishPattern" | "getPattern" | "listLineages" | "getSharingSettings"
    >,
  ) => {
    const opened = { count: 0 };
    const deps: VersionDeps = {
      store,
      openClient: () => {
        opened.count += 1;
        return Promise.resolve(client);
      },
      readTextFile: (path) => Deno.readTextFile(path),
      checkoutOf: () => Promise.resolve(undefined),
    };
    return { deps, opened };
  };

  const deployed = (more: Partial<DeployedSource> = {}): DeployedSource => ({
    entry,
    program: PROGRAM,
    patternId: () => Promise.resolve("pat-1"),
    piece: { space: "did:key:z6Mkspace", id: "fid1:piece" },
    ...more,
  });

  describe("recordDeployedVersion()", () => {
    it("records a joined person's deploy as their own version under a slot that names no directory", async () => {
      await joinIndex();
      const { client, published } = stubClient();
      const { deps } = depsWith(client);

      const outcome = await recordDeployedVersion(deployed(), deps);

      expect(outcome.status).toBe("recorded");
      expect(published).toHaveLength(1);
      const request = published[0];
      expect(request.patternId).toBe("pat-1");
      expect(request.origin).toBe("self");
      expect(request.slot).toBe(
        await entrySlot(entry, {
          pathKey: () => store.slotKey(),
          checkoutOf: () => Promise.resolve(undefined),
        }),
      );
      expect(request.description).toBe(
        "Reminds the household to take the bins out on collection day.",
      );
      expect(request.hashtags).toEqual(["chores"]);
      expect(request.program.files).toEqual(PROGRAM.files);
      expect(Object.hasOwn(request, "keepPrivate")).toBe(false);
      expect(request.deployedTo).toBe(
        deployedPieceRef("did:key:z6Mkspace", "fid1:piece"),
      );
    });

    it("asks the index to keep the version private when the deploy says so", async () => {
      await joinIndex();
      const { client, published } = stubClient();
      const { deps } = depsWith(client);

      await recordDeployedVersion(deployed({ keepPrivate: true }), deps);

      expect(published.map((r) => r.keepPrivate)).toEqual([true]);
    });

    it("makes no index call and reads no pattern id on a machine that never joined, and says so only the first time", async () => {
      const { client, published } = stubClient();
      const { deps, opened } = depsWith(client);
      let reads = 0;
      const unread = deployed({
        patternId: () => {
          reads += 1;
          return Promise.resolve("pat-1");
        },
      });

      const first = await recordDeployedVersion(unread, deps);
      const second = await recordDeployedVersion(unread, deps);

      expect(first).toEqual({ status: "not-joined", firstTime: true });
      expect(second).toEqual({ status: "not-joined", firstTime: false });
      expect(opened.count).toBe(0);
      expect(reads).toBe(0);
      expect(published).toHaveLength(0);
      expect(versionLine(first)).toContain("cf index join");
      expect(versionLine(second)).toBeUndefined();
    });

    it("says the index shares the version once it is opened in a loom, when it answers so", async () => {
      await joinIndex();
      const { client } = stubClient({
        publish: () =>
          Promise.resolve({ ...RECORDED, autoShare: "when_used" as const }),
      });
      const { deps } = depsWith(client);

      const outcome = await recordDeployedVersion(deployed(), deps);

      expect(versionLine(outcome)).toContain(
        "shares it anonymously once you open it in a loom",
      );
    });

    it("sends no source to an index that does not keep private versions", async () => {
      await joinIndex();
      const { client, published } = stubClient({ keepsVersions: false });
      const { deps } = depsWith(client);

      const outcome = await recordDeployedVersion(deployed(), deps);

      expect(outcome.status).toBe("skipped");
      expect(published).toHaveLength(0);
      expect(await store.keepsVersions()).toBe(false);
    });

    it("records nothing for a piece that follows an origin, which is not the person's source", async () => {
      await joinIndex();
      const { client, published } = stubClient();
      const { deps, opened } = depsWith(client);

      const outcome = await recordDeployedVersion(
        deployed({ origin: "system:system/profile-home/profile-home.tsx" }),
        deps,
      );

      expect(outcome.status).toBe("skipped");
      expect(opened.count).toBe(0);
      expect(published).toHaveLength(0);
      expect(versionLine(outcome)).toBeUndefined();
    });

    it("records nothing for someone else's pattern fetched and deployed unchanged", async () => {
      await joinIndex();
      await store.recordSource([entry], "pat-1");
      const { client, published } = stubClient({
        patterns: { "pat-1": { patternId: "pat-1", mine: false } },
      });
      const { deps } = depsWith(client);

      const outcome = await recordDeployedVersion(deployed(), deps);

      expect(outcome.status).toBe("skipped");
      expect(published).toHaveLength(0);
    });

    it("records an edit of someone else's pattern as the person's remix of it", async () => {
      await joinIndex();
      await store.recordSource([entry], "pat-theirs");
      const { client, published } = stubClient({
        patterns: { "pat-theirs": { patternId: "pat-theirs", mine: false } },
      });
      const { deps } = depsWith(client);

      const outcome = await recordDeployedVersion(deployed(), deps);

      expect(outcome.status).toBe("recorded");
      expect(published[0].remixedFrom).toBe("pat-theirs");
    });

    it("credits the remix only on the version that starts its lineage", async () => {
      await joinIndex();
      await store.recordSource([entry], "pat-theirs");
      const slot = await entrySlot(entry, {
        pathKey: () => store.slotKey(),
        checkoutOf: () => Promise.resolve(undefined),
      });
      const { client, published } = stubClient({
        patterns: { "pat-theirs": { patternId: "pat-theirs", mine: false } },
        slots: [slot],
      });
      const { deps } = depsWith(client);

      await recordDeployedVersion(deployed(), deps);

      expect(Object.hasOwn(published[0], "remixedFrom")).toBe(false);
    });

    it("continues the person's own fetched pattern without crediting it as a remix", async () => {
      await joinIndex();
      await store.recordSource([entry], "pat-mine");
      const { client, published } = stubClient({
        patterns: { "pat-mine": { patternId: "pat-mine", mine: true } },
      });
      const { deps } = depsWith(client);

      await recordDeployedVersion(deployed(), deps);

      expect(Object.hasOwn(published[0], "remixedFrom")).toBe(false);
    });

    it("answers an unreachable index as an outcome rather than throwing", async () => {
      await joinIndex();
      const { client } = stubClient({
        publish: () => Promise.reject(new TypeError("connection refused")),
      });
      const { deps } = depsWith(client);

      const outcome = await recordDeployedVersion(deployed(), deps);

      expect(outcome).toEqual({
        status: "failed",
        reason: "connection refused",
      });
      expect(versionLine(outcome)).toContain("The deploy itself succeeded");
    });

    it("names joining when the index does not know the identity", async () => {
      await joinIndex();
      const { client } = stubClient({
        publish: () => Promise.reject(new PatternIndexError("publish", 403)),
      });
      const { deps } = depsWith(client);

      const outcome = await recordDeployedVersion(deployed(), deps);

      expect(outcome.status).toBe("failed");
      expect(versionLine(outcome)).toContain("cf index join");
    });
  });

  describe("entrySlot()", () => {
    it("answers one slot for the same file in two checkouts of one repository, whatever the remote's spelling", async () => {
      const a = join(dir, "a");
      const b = join(dir, "b");
      await Deno.mkdir(join(a, "patterns"), { recursive: true });
      await Deno.mkdir(join(b, "patterns"), { recursive: true });
      const checkouts: Record<string, string> = {
        [join(a, "patterns")]: "git@github.com:acme/patterns.git",
        [join(b, "patterns")]: "https://github.com/acme/patterns",
      };
      const checkoutOf = (d: string) =>
        Promise.resolve({
          root: d === join(a, "patterns") ? a : b,
          remote: checkouts[d],
        });
      const pathKey = () => Promise.reject(new Error("unused in a checkout"));

      const first = await entrySlot(join(a, "patterns", "bins.tsx"), {
        pathKey,
        checkoutOf,
      });
      const second = await entrySlot(join(b, "patterns", "bins.tsx"), {
        pathKey,
        checkoutOf,
      });
      const other = await entrySlot(join(b, "patterns", "other.tsx"), {
        pathKey,
        checkoutOf,
      });

      expect(first).toMatch(/^cf-git:[0-9a-f]{64}$/);
      expect(second).toBe(first);
      expect(other).not.toBe(first);
    });

    it("tells apart repositories whose paths differ only in case, but not hosts that do", async () => {
      const slotFor = (remote: string) =>
        entrySlot(join(dir, "bins.tsx"), {
          pathKey: () => Promise.reject(new Error("unused in a checkout")),
          checkoutOf: () => Promise.resolve({ root: dir, remote }),
        });

      expect(await slotFor("git@GitHub.com:acme/Patterns.git")).toBe(
        await slotFor("https://github.com/acme/Patterns"),
      );
      expect(await slotFor("https://github.com/acme/Patterns")).not.toBe(
        await slotFor("https://github.com/acme/patterns"),
      );
    });

    it("keys the path outside a checkout with the machine's key, so the slot cannot confirm a guessed path", async () => {
      const outside = () => Promise.resolve(undefined);
      const keyed = (byte: number) => () =>
        Promise.resolve(new Uint8Array(32).fill(byte));

      const one = await entrySlot(entry, {
        pathKey: keyed(1),
        checkoutOf: outside,
      });
      const again = await entrySlot(entry, {
        pathKey: keyed(1),
        checkoutOf: outside,
      });
      const otherKey = await entrySlot(entry, {
        pathKey: keyed(2),
        checkoutOf: outside,
      });

      expect(one).toMatch(/^cf-path:[0-9a-f]{64}$/);
      expect(again).toBe(one);
      expect(otherKey).not.toBe(one);
    });
  });

  describe("versionLine()", () => {
    const recorded = (
      response: Partial<PatternIndexPublishResponse>,
    ): VersionOutcome => ({
      status: "recorded",
      created: response.created ?? true,
      response: { ...RECORDED, ...response },
    });

    it("names the private version it kept", () => {
      expect(versionLine(recorded({}))).toBe(
        "Kept as private version 3; cf pattern history lists them.",
      );
    });

    it("says nothing about sharing while the setting keeps it private", () => {
      expect(versionLine(recorded({ autoShare: "sharing_off" }))).not
        .toContain("loom");
    });

    it("says no version was made when the newest already has this source", () => {
      expect(versionLine(recorded({ created: false }))).toBe(
        "No new version: your newest one already has this source.",
      );
    });
  });

  describe("recordVersionInIndex()", () => {
    it("answers a pattern index URL it cannot use as a failed version instead of throwing", async () => {
      const before = Deno.env.get("CF_PATTERN_INDEX_URL");
      Deno.env.set("CF_PATTERN_INDEX_URL", "https://index.test/?x=1");
      try {
        const outcome = await recordVersionInIndex(
          "/unused/test.key",
          deployed(),
        );

        expect(outcome.status).toBe("failed");
      } finally {
        if (before === undefined) Deno.env.delete("CF_PATTERN_INDEX_URL");
        else Deno.env.set("CF_PATTERN_INDEX_URL", before);
      }
    });
  });

  describe("piece setsrc", () => {
    it("prints the version's line after the deploy's own, and leaves the exit status alone when the index fails", async () => {
      const lines: string[] = [];
      const exitCodes: number[] = [];
      await applyPieceSourceCommandAction(
        { identity: "/unused/test.key", space: "s", apiUrl: "https://cf.dev" },
        entry,
        {
          setPieceSourceFromCommand: (_options, _main, deps) => {
            deps?.onDeployed?.({
              program: PROGRAM,
              patternId: () => Promise.resolve("pat-1"),
              piece: { space: "did:key:z6Mkspace", id: "fid1:p" },
            });
            return Promise.resolve({
              config: { piece: "fid1:p" },
              update: {
                ref: { identity: "pat-1", symbol: "default" },
                revisionId: "rev-1",
                seq: 7,
                refresh: { status: "completed" },
              },
            } as never);
          },
          recordVersion: () =>
            Promise.resolve({ status: "failed", reason: "index down" }),
          render: (line) => lines.push(`render: ${line}`),
          warn: (line) => lines.push(`warn: ${line}`),
          hint: () => {},
          setExitCode: (code) => exitCodes.push(code),
        },
      );

      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^render: Committed source update/);
      expect(lines[1]).toBe(
        "warn: Version not kept: index down. The deploy itself succeeded.",
      );
      expect(exitCodes).toEqual([]);
    });

    it("hands the version recorder the --origin a deploy follows", async () => {
      const recorded: DeployedSource[] = [];
      await applyPieceSourceCommandAction(
        {
          identity: "/unused/test.key",
          space: "s",
          apiUrl: "https://cf.dev",
          origin: "system:x.tsx",
        } as never,
        entry,
        {
          setPieceSourceFromCommand: (_options, _main, deps) => {
            deps?.onDeployed?.({
              program: PROGRAM,
              patternId: () => Promise.resolve("pat-1"),
              piece: { space: "did:key:z6Mkspace", id: "fid1:p" },
            });
            return Promise.resolve({
              config: { piece: "fid1:p" },
              update: {
                ref: { identity: "pat-1", symbol: "default" },
                revisionId: "rev-1",
                seq: 7,
                origin: "system:x.tsx",
                refresh: { status: "completed" },
              },
            } as never);
          },
          recordVersion: (deployed) => {
            recorded.push(deployed);
            return Promise.resolve({ status: "skipped", reason: "origin" });
          },
          render: () => {},
          warn: () => {},
          hint: () => {},
        },
      );

      expect(recorded.map((d) => [d.entry, d.origin])).toEqual([
        [entry, "system:x.tsx"],
      ]);
    });
  });

  describe("piece new", () => {
    it("carries the version's outcome in its --json receipt", async () => {
      const printed: unknown[] = [];
      await captureStderr(() =>
        newPieceFromCommand(
          {
            apiUrl: "https://cf.dev",
            space: "s",
            identity: "/unused/test.key",
            quiet: true,
            json: true,
          },
          entry,
          {
            newPiece: (_config, _entry, options) => {
              options?.onDeployed?.({
                program: PROGRAM,
                patternId: () => Promise.resolve("pat-1"),
                piece: { space: "did:key:z6Mkspace", id: "fid1:created" },
              });
              return Promise.resolve({ pieceId: "fid1:created" });
            },
            recordVersion: () =>
              Promise.resolve({
                status: "recorded",
                created: true,
                response: RECORDED,
              }),
            render: (value) => printed.push(value),
            note: () => {},
          },
        )
      );

      expect(printed).toEqual([{
        pieceId: "fid1:created",
        version: {
          status: "recorded",
          version: 3,
          visibility: "private",
          autoShare: "sharing_off",
        },
      }]);
    });

    it("records a version of a piece made from a file, and none of one made from the index", async () => {
      const recorded: DeployedSource[] = [];
      const deps = {
        newPiece: (
          _config: unknown,
          _entry: unknown,
          options?: {
            onDeployed?: (d: {
              program: RuntimeProgram;
              patternId: () => Promise<string | undefined>;
              piece: { space: string; id: string };
            }) => void;
          },
        ) => {
          options?.onDeployed?.({
            program: PROGRAM,
            patternId: () => Promise.resolve("pat-1"),
            piece: { space: "did:key:z6Mkspace", id: "fid1:created" },
          });
          return Promise.resolve({ pieceId: "fid1:created" });
        },
        recordIndexedPiece: () => Promise.resolve(),
        recordVersion: (d: DeployedSource) => {
          recorded.push(d);
          return Promise.resolve<VersionOutcome>({
            status: "skipped",
            reason: "test",
          });
        },
        render: () => {},
        note: () => {},
      };
      const config = {
        apiUrl: "https://cf.dev",
        space: "s",
        identity: "/unused/test.key",
        quiet: true,
      };
      await captureStderr(() =>
        newPieceFromCommand(config, entry, deps as never)
      );
      await captureStderr(() =>
        newPieceFromCommand(
          {
            ...config,
            fromIndex: "pat-theirs",
            patternIndexUrl: "https://index.example",
          },
          undefined,
          deps as never,
        )
      );

      expect(recorded.map((d) => d.entry)).toEqual([entry]);
    });
  });
});
