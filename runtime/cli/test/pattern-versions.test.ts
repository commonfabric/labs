import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  type PatternIndexClient,
  PatternIndexError,
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
} = {}) => {
  const published: PatternIndexPublishRequest[] = [];
  const client: Pick<PatternIndexClient, "publishPattern" | "getPattern"> = {
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
    client: Pick<PatternIndexClient, "publishPattern" | "getPattern">,
  ) => {
    const opened = { count: 0 };
    const deps: VersionDeps = {
      store,
      openClient: () => {
        opened.count += 1;
        return Promise.resolve(client);
      },
      readTextFile: (path) => Deno.readTextFile(path),
    };
    return { deps, opened };
  };

  const deployed = (more: Partial<DeployedSource> = {}): DeployedSource => ({
    entry,
    program: PROGRAM,
    patternId: "pat-1",
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
      expect(request.slot).toBe(await entrySlot(entry));
      expect(request.slot).not.toContain(dir);
      expect(request.description).toBe(
        "Reminds the household to take the bins out on collection day.",
      );
      expect(request.hashtags).toEqual(["chores"]);
      expect(request.program.files).toEqual(PROGRAM.files);
      expect(Object.hasOwn(request, "keepPrivate")).toBe(false);
    });

    it("makes no index call on a machine that never joined, and says so only the first time", async () => {
      const { client, published } = stubClient();
      const { deps, opened } = depsWith(client);

      const first = await recordDeployedVersion(deployed(), deps);
      const second = await recordDeployedVersion(deployed(), deps);

      expect(first).toEqual({ status: "not-joined", firstTime: true });
      expect(second).toEqual({ status: "not-joined", firstTime: false });
      expect(opened.count).toBe(0);
      expect(published).toHaveLength(0);
      expect(versionLine(first)).toContain("cf index join");
      expect(versionLine(second)).toBeUndefined();
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

  describe("versionLine()", () => {
    const recorded = (
      response: Partial<PatternIndexPublishResponse>,
    ): VersionOutcome => ({
      status: "recorded",
      created: response.created ?? true,
      response: { ...RECORDED, ...response },
    });

    it("names the version and that it stays private while sharing is off", () => {
      expect(versionLine(recorded({}))).toBe(
        "Kept as version 3 (private); cf pattern history lists them.",
      );
    });

    it("says the index will share it once its privacy check passes", () => {
      expect(versionLine(recorded({ autoShare: "requested" }))).toContain(
        "shared anonymously once the privacy check passes",
      );
    });

    it("says no version was made when the newest already has this source", () => {
      expect(versionLine(recorded({ created: false }))).toBe(
        "No new version: your newest one already has this source.",
      );
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
            deps?.onDeployed?.({ program: PROGRAM, patternId: "pat-1" });
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
            deps?.onDeployed?.({ program: PROGRAM, patternId: "pat-1" });
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
    it("records a version of a piece made from a file, and none of one made from the index", async () => {
      const recorded: DeployedSource[] = [];
      const deps = {
        newPiece: (
          _config: unknown,
          _entry: unknown,
          options?: {
            onDeployed?: (d: { program: RuntimeProgram }) => void;
          },
        ) => {
          options?.onDeployed?.({ program: PROGRAM });
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
