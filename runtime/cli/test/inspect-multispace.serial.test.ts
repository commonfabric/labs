import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  it,
} from "@std/testing/bdd";
import { expect } from "@std/expect";
import { toFileUrl } from "@std/path";
import {
  type CurrencyRecord,
  storeCurrencyRecords,
} from "@commonfabric/memory/v2/currency-index";
import { close, open } from "@commonfabric/memory/v2/engine";
import { defaultCacheDir } from "@commonfabric/state-inspector";

import {
  ALICE,
  ALICE_S1,
  BOB,
  CONV_A,
  CONV_B,
  CONV_C,
  EMPTY,
  HOME,
  MAIN,
  runInspect,
  runInspectJson,
  seedConvergeSpaces,
  seedSpace,
  seedWorld,
  sessionOf,
} from "./inspect-fixtures.ts";

const BASE = "http://inspect-multispace-remote.invalid:9999";
const DUMP = "/api/storage/memory/dump";
const ENV_KEYS = [
  "HOME",
  "MEMORY_DIR",
  "DB_PATH",
  "CF_API_URL",
  "CF_IDENTITY",
] as const;
const CAVEAT =
  "note: Server-view only: durable values compared. Client cursor lag, " +
  "pending optimistic writes, and render state are not visible here — " +
  "'converged' means the stored values agree, not that every client is " +
  "displaying them.";

/** What a command printed to stdout, one line per element, right-trimmed. */
async function lines(argv: string[]): Promise<string[]> {
  const { stdout } = await runInspect(argv);
  return stdout.join("\n").split("\n").map((line) => line.trimEnd());
}

describe("inspect-multispace", () => {
  let fixtures: string;
  let world: string;
  let conv: string;
  let spaceBytes: Uint8Array<ArrayBuffer>;
  let scratch: string;
  let home: string;
  let cwd: string;
  const savedEnv = new Map<string, string | undefined>();
  let savedCwd: string;
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    fixtures = await Deno.makeTempDir({ prefix: "inspect-multispace-" });
    world = `${fixtures}/world`;
    conv = `${fixtures}/conv`;
    await Deno.mkdir(world);
    await Deno.mkdir(conv);
    seedWorld(world);
    seedConvergeSpaces(conv);
    const one = `${fixtures}/one.sqlite`;
    seedSpace(one, [{
      session: sessionOf(ALICE, ALICE_S1),
      revisions: [{ id: "of:a", document: { value: 1 } }],
    }]);
    spaceBytes = await Deno.readFile(one);
  });

  afterAll(async () => {
    await Deno.remove(fixtures, { recursive: true });
  });

  // Discovery searches `$HOME`, `MEMORY_DIR`, `DB_PATH`, and the working
  // directory's ancestors besides `--dir`, so each case gets empty ones.
  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv.set(key, Deno.env.get(key));
    savedCwd = Deno.cwd();
    scratch = await Deno.makeTempDir({ prefix: "inspect-multispace-env-" });
    home = `${scratch}/home`;
    cwd = `${scratch}/cwd`;
    await Deno.mkdir(home);
    await Deno.mkdir(cwd);
    for (const key of ENV_KEYS) Deno.env.delete(key);
    Deno.env.set("HOME", home);
    Deno.chdir(cwd);
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    Deno.chdir(savedCwd);
    for (const [key, value] of savedEnv) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(scratch, { recursive: true });
  });

  /** Serves `spaces` as the remote listing, and every space as one DB. */
  function stubRemote(
    spaces: { space: string; sizeBytes: number; mtimeMs: number }[],
  ): { requests: number } {
    const state = { requests: 0 };
    const stub: typeof fetch = (input) => {
      state.requests++;
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname === DUMP) {
        return Promise.resolve(Response.json({ spaces }));
      }
      return Promise.resolve(new Response(spaceBytes));
    };
    globalThis.fetch = stub;
    return state;
  }

  describe("spaces", () => {
    it("lists discovered DBs with their sizes and stats, and `?` where a file holds no space", async () => {
      const output = await lines(["spaces", "--dir", world]);
      expect(output[0].split(/\s+/)).toEqual([
        "DID",
        "SIZE",
        "COMMITS",
        "ENTITIES",
        "LAST",
        "ACTIVITY",
      ]);
      const row = (did: string) =>
        output.find((line) => line.startsWith(`${did} `))?.split(/\s+/);
      expect(row(MAIN)?.slice(2)).toEqual([
        "3",
        "2",
        "2026-01-01",
        "00:02:00",
      ]);
      expect(row(MAIN)?.[1]).toMatch(/^\d+K$/);
      expect(row(EMPTY)?.slice(2)).toEqual(["0", "0", "?"]);
      expect(row("junk")).toEqual(["junk", "14B", "?", "?", "?"]);
      expect(output).toHaveLength(6);

      const rows = await runInspectJson(["spaces", "--dir", world]);
      expect(rows).toContainEqual(expect.objectContaining({
        did: MAIN,
        commits: 3,
        entities: 2,
        lastActivity: "2026-01-01 00:02:00",
      }));
    });

    it("prints where to look when it finds no DB", async () => {
      expect(await lines(["spaces"])).toEqual([
        "no space DBs found (set MEMORY_DIR, pass --dir, or run from a repo with cache/memory/…).",
      ]);
    });

    it("lists a remote's spaces with human-readable sizes", async () => {
      stubRemote([
        { space: CONV_A, sizeBytes: 10, mtimeMs: 0 },
        { space: CONV_B, sizeBytes: 2048, mtimeMs: 0 },
        { space: CONV_C, sizeBytes: 3 * 1024 * 1024, mtimeMs: 0 },
        { space: MAIN, sizeBytes: 5 * 1024 * 1024 * 1024, mtimeMs: 0 },
      ]);
      const output = await lines(["spaces", "--remote", BASE]);
      expect(output[0]).toBe(`4 space(s) at ${BASE}:`);
      expect(output[1].split(/\s+/)).toEqual(["DID", "SIZE", "MODIFIED"]);
      expect(output.slice(2, 6).map((line) => line.split(/\s+/))).toEqual([
        [CONV_A, "10B", "1970-01-01T00:00:00.000Z"],
        [CONV_B, "2K", "1970-01-01T00:00:00.000Z"],
        [CONV_C, "3.0M", "1970-01-01T00:00:00.000Z"],
        [MAIN, "5.0G", "1970-01-01T00:00:00.000Z"],
      ]);
      expect(output.slice(6)).toEqual([
        "",
        "tip: `inspect summary <did> --remote` fetches + inspects one; `inspect pull --all --remote` caches them all.",
      ]);
    });

    it("prints that a remote with no spaces has none available", async () => {
      stubRemote([]);
      expect(await lines(["spaces", "--remote", BASE])).toEqual([
        `no spaces available at ${BASE}.`,
      ]);
    });
  });

  describe("pull", () => {
    it("prints which spaces it cached and where", async () => {
      stubRemote([{ space: CONV_A, sizeBytes: 10, mtimeMs: 0 }]);
      const cacheDir = defaultCacheDir(BASE);
      expect(cacheDir.startsWith(home)).toBe(true);
      expect(await lines(["pull", CONV_A, "--remote", BASE])).toEqual([
        `pulled 1 space(s) into ${cacheDir}:`,
        `  ${CONV_A}`,
        "",
        "now inspect them offline, e.g. `inspect summary <did-prefix>`.",
      ]);
      expect(await Deno.readFile(`${cacheDir}/${CONV_A}.sqlite`)).toEqual(
        spaceBytes,
      );
    });

    it("throws, without fetching, given neither a space nor `--all`", async () => {
      const remote = stubRemote([]);
      await expect(runInspect(["pull", "--remote", BASE, "--json"])).rejects
        .toThrow("provide a <space> or --all.");
      expect(remote.requests).toBe(0);
    });
  });

  describe("group", () => {
    it("prints one line per user group, biggest first", async () => {
      expect(await lines(["group", "--dir", world])).toEqual([
        "2 user group(s)  —  use --did <prefix> to expand one",
        "● z6MkInsp…HHHH  home=present  profiles=2  main=1  (+1 absent)",
        "● z6MkInsp…EEEE  home=absent  profiles=0  main=1",
      ]);
      expect(await runInspectJson(["group", "--dir", world])).toMatchObject({
        groups: [{ principal: HOME, homePresent: true }, {
          principal: EMPTY,
          homePresent: false,
        }],
        ungrouped: [],
      });
    });

    it("expands the group whose principal matches `--did`", async () => {
      expect(await lines(["group", "--dir", world, "--did", "Home"])).toEqual([
        "● user z6MkInsp…HHHH",
        "   home    z6MkInsp…HHHH  commits=2 entities=2  · home pieces (profiles + createProfile); group principal (owner home)",
        "   profile z6MkInsp…PPPP  commits=1 entities=1  · listed in profiles[] of z6MkIn…HHHH",
        "   profile z6MkInsp…XXXX  (absent — referenced, no local DB)  · listed in profiles[] of z6MkIn…HHHH",
        "   main    z6MkInsp…MMMM  commits=3 entities=2  · written by principal z6MkIn…HHHH",
      ]);
    });

    it("marks a group without a home and a space without commits", async () => {
      expect(await lines(["group", "--dir", world, "--did", "Empty"])).toEqual([
        "● user z6MkInsp…EEEE  (home absent/empty locally)",
        "   main    z6MkInsp…EEEE  commits=0 entities=0  (placeholder/empty)  · group principal (owner home)",
      ]);
    });

    it("prints that no principal matches an unknown `--did`", async () => {
      expect(await lines(["group", "--dir", world, "--did", "nomatch"]))
        .toEqual(['no group principal matches "nomatch".']);
    });

    it("prints that it finds no DB", async () => {
      expect(await lines(["group"])).toEqual(["no space DBs found."]);
    });
  });

  describe("identity", () => {
    it("prints an identity's spaces and the scopes it owns in each", async () => {
      expect(await lines(["identity", HOME, "--dir", world])).toEqual([
        "● identity z6MkInsp…HHHH",
        "  3/4 spaces present · 1 with per-user/session state · 2 scoped entities",
        "  home    z6MkInsp…HHHH  entities=2",
        "  profile z6MkInsp…PPPP  entities=1",
        "  profile z6MkInsp…XXXX  (absent — referenced, no local DB)",
        "  main    z6MkInsp…MMMM  entities=2",
        "      user  entities=1 revs=1",
        "      session /11111111  entities=1 revs=1",
        "",
        `tip: \`inspect value-at <space> <id> --as ${HOME}\` reads a cell as this identity.`,
      ]);
    });

    it("prints the spaces where an identity without a home owns scopes", async () => {
      expect(await lines(["identity", BOB, "--dir", world])).toEqual([
        "● identity z6MkInsp…BBBB  (home absent/empty locally)",
        "  1/1 spaces present · 1 with per-user/session state · 1 scoped entities",
        "  main    z6MkInsp…MMMM  entities=0",
        "      user  entities=1 revs=1",
        "",
        `tip: \`inspect value-at <space> <id> --as ${BOB}\` reads a cell as this identity.`,
      ]);
      expect(await runInspectJson(["identity", BOB, "--dir", world]))
        .toMatchObject({
          did: BOB,
          homePresent: false,
          totals: { spaces: 1, scopedEntities: 1 },
        });
    });

    it("prints no tip for an identity with no scoped state", async () => {
      expect(
        await lines(["identity", "did:key:z6MkNobody", "--dir", world]),
      ).toEqual([
        "● identity z6MkNobody  (home absent/empty locally)",
        "  0/0 spaces present · 0 with per-user/session state · 0 scoped entities",
      ]);
    });
  });

  describe("converge", () => {
    it("prints each space's view of an entity one space lacks", async () => {
      expect(await lines(["converge", "of:partial", "--dir", conv])).toEqual([
        "verdict: PARTIAL  [no-cross-space-link]",
        "entity:  of:partial",
        `  ${CONV_A}.sqlite\thead=1\trevs=1\tlast=z6MkIn…AAAA/aaaaaaaa\tcluster#1`,
        `  ${CONV_B}.sqlite\thead=1\trevs=1\tlast=z6MkIn…AAAA/aaaaaaaa\tcluster#1`,
        `  ${CONV_C}.sqlite\tABSENT`,
        CAVEAT,
      ]);
    });

    it("prints a value that does not decode as an error", async () => {
      const output = await lines(["converge", "of:broken", "--dir", conv]);
      expect(output[0]).toBe("verdict: UNKNOWN");
      expect(output[3]).toMatch(
        new RegExp(`^  ${CONV_B}\\.sqlite\\tERROR\\t\\S`),
      );
    });

    it("puts linked values that differ in separate clusters", async () => {
      const output = await lines(["converge", "of:drift", "--dir", conv]);
      expect(output[0]).toBe("verdict: DIVERGED  [cross-space-linked]");
      expect(output[2]).toMatch(/\tcluster#1$/);
      expect(output[3]).toMatch(/\tcluster#2$/);
    });

    it("marks a path the value lacks, and a write no commit records", async () => {
      expect(
        (await lines([
          "converge",
          "of:same",
          "--dir",
          conv,
          "--path",
          "deep/y",
        ])).slice(0, 3),
      ).toEqual([
        "verdict: CONVERGED",
        "entity:  of:same  path=/deep/y",
        `  ${CONV_A}.sqlite\thead=1\trevs=1\tlast=z6MkIn…AAAA/aaaaaaaa\tcluster#1\tpath=MISSING`,
      ]);
      expect(
        (await lines(["converge", "of:orphan", "--dir", conv]))[4],
      ).toBe(`  ${CONV_C}.sqlite\thead=1\trevs=1\tlast=?\tcluster#1`);
    });

    it("compares the spaces `--spaces` names", async () => {
      expect(
        await runInspectJson([
          "converge",
          "of:drift",
          "--spaces",
          `${conv}/${CONV_A}.sqlite,${conv}/${CONV_C}.sqlite`,
        ]),
      ).toMatchObject({
        verdict: "partial",
        views: [{ label: `${CONV_A}.sqlite`, present: true }, {
          label: `${CONV_C}.sqlite`,
          present: false,
        }],
      });
    });

    it("compares every space `--all` discovers", async () => {
      await Deno.mkdir(`${cwd}/cache/memory`, { recursive: true });
      seedConvergeSpaces(`${cwd}/cache/memory`);
      const result = await runInspectJson(["converge", "of:same", "--all"]);
      expect(result).toMatchObject({ verdict: "converged" });
      expect(result).toHaveProperty("views.length", 3);
    });
  });

  describe("converge-scan", () => {
    it("lists the shared entities that diverge, are partial, or are unknown", async () => {
      expect(await lines(["converge-scan", "--dir", conv])).toEqual([
        "shared entities (in >=2 spaces): 4  examined: 4",
        "cross-space link edges: 1  (1 real-drift / 1 likely-independent / 1 unknown)",
        "findings (diverged/partial/unknown): 3",
        "  UNKNOWN\t?\tof:broken\tpresent=2\tmissing=1\tclusters=1",
        "  DIVERGED\tDRIFT\tof:drift\tpresent=2\tmissing=1\tclusters=2",
        "  PARTIAL\tinstance?\tof:partial\tpresent=2\tmissing=1\tclusters=1",
      ]);
    });

    it("prints no missing count for a finding every space holds", async () => {
      const output = await lines([
        "converge-scan",
        "--spaces",
        `${conv}/${CONV_A}.sqlite,${conv}/${CONV_B}.sqlite`,
      ]);
      expect(output).toContain(
        "  DIVERGED\tDRIFT\tof:drift\tpresent=2\tclusters=2",
      );
      expect(output).not.toContain(
        "  PARTIAL\tinstance?\tof:partial\tpresent=2\tmissing=1\tclusters=1",
      );
    });
  });

  describe("currency-cycles", () => {
    /** The directory the stores of these cases are in. */
    let stores: string;

    /**
     * A record of `piece`, which writes `writes` and reads `read` in
     * `source`.
     */
    const reading = (
      piece: string,
      writes: string,
      source: string,
      read: string,
    ): CurrencyRecord => ({
      piece,
      under: [],
      vouched: true,
      writes: [writes],
      owned: [],
      slices: [{
        key: "space",
        vouched: true,
        reads: [{ space: source, id: read, scopeKey: "space", derived: false }],
        vouches: [],
      }],
    });

    /** Writes a store for `space` whose currency index holds `records`. */
    const seedCurrency = async (space: string, records: CurrencyRecord[]) => {
      const engine = await open({
        url: toFileUrl(`${stores}/${space}.sqlite`),
      });
      storeCurrencyRecords(engine, {
        space,
        asOf: 0,
        seen: [],
        epoch: "epoch-one",
        records,
      });
      close(engine);
    };

    beforeEach(async () => {
      stores = `${scratch}/stores`;
      await Deno.mkdir(stores);
      await seedCurrency(CONV_A, [
        reading("of:first", "of:a", CONV_B, "of:b"),
      ]);
      await seedCurrency(CONV_B, [
        reading("of:second", "of:b", CONV_A, "of:a"),
      ]);
    });

    it("prints the pieces in two spaces that read what each other write, with the documents", async () => {
      expect(await lines(["currency-cycles", "--dir", stores])).toEqual([
        "spaces examined: 2  with a currency index: 2  pieces recorded: 2",
        "reads across spaces: 2",
        `  ${CONV_B} reads 1 document(s) of ${CONV_A}`,
        `  ${CONV_A} reads 1 document(s) of ${CONV_B}`,
        "cycles across spaces: 1",
        "  2 piece(s) in 2 spaces",
        `    ${CONV_A} of:first writes of:a, read by ${CONV_B} of:second in space`,
        `    ${CONV_B} of:second writes of:b, read by ${CONV_A} of:first in space`,
      ]);
    });

    it("names a space that was read and not examined, and prints no cycle through it", async () => {
      expect(
        await lines([
          "currency-cycles",
          "--spaces",
          `${stores}/${CONV_A}.sqlite`,
        ]),
      ).toEqual([
        "spaces examined: 1  with a currency index: 1  pieces recorded: 1",
        "reads across spaces: 1",
        `  ${CONV_A} reads 1 document(s) of ${CONV_B}`,
        "read and not examined, so a cycle through one is not seen: " + CONV_B,
        "cycles across spaces: 0",
      ]);
    });

    it("returns the cycles as JSON", async () => {
      expect(await runInspectJson(["currency-cycles", "--dir", stores]))
        .toMatchObject({
          cycleCount: 1,
          cycles: [{ spaces: [CONV_A, CONV_B], pieces: 2 }],
          unexamined: [],
        });
    });
  });
});
