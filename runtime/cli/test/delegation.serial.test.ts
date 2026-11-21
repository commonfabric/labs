/**
 * Drives `cf delegation issue` over a stand-in connection, and
 * `cf delegation show` through the parsed command, in-process. Serial, since
 * both write to standard output, which the tests replace to read it.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  decodeDelegation,
  decodeDelegationChains,
  encodeDelegationChains,
  Identity,
  issueDelegation,
} from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/runner";
import { decode } from "@commonfabric/text/utf8";
import { PatternIndexStore } from "@commonfabric/pattern-index/store";
import { ValidationError } from "@cliffy/command";

import {
  delegation,
  delegationIssueAction,
  type IssueConnection,
} from "../commands/delegation.ts";
import { stripAnsi } from "./utils.ts";

const agent = await Identity.fromPassphrase("cf delegation agent");

/** What is written to standard output, by `render()` or by a table, in `fn`. */
async function captureOutput(fn: () => Promise<unknown>): Promise<string> {
  let captured = "";
  const originalWrite = Deno.stdout.writeSync;
  const originalLog = console.log;
  Deno.stdout.writeSync = (data: Uint8Array): number => {
    captured += decode(data);
    return data.length;
  };
  console.log = (...args: unknown[]) => {
    captured += args.join(" ") + "\n";
  };
  try {
    await fn();
  } finally {
    Deno.stdout.writeSync = originalWrite;
    console.log = originalLog;
  }
  return stripAnsi(captured);
}

describe("delegation", () => {
  let dir: string;
  let keyPath: string;
  let signer: Identity;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "cf-delegation-" });
    keyPath = join(dir, "me.key");
    const pkcs8 = await Identity.generatePkcs8();
    await Deno.writeFile(keyPath, pkcs8);
    signer = await Identity.fromPkcs8(pkcs8);
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  describe("delegationIssueAction()", () => {
    /** A connection to `space`, which counts its disposals. */
    const connectionTo = (space: MemorySpace) => {
      const state = { disposed: 0 };
      const connection: IssueConnection = {
        getSpace: () => space,
        runtime: { storageManager: {} },
        dispose: () => {
          state.disposed++;
          return Promise.resolve();
        },
      };
      return { state, load: () => Promise.resolve(connection) };
    };

    const options = (space: string) => ({
      identity: keyPath,
      apiUrl: "http://127.0.0.1:8000",
      space,
      to: agent.did(),
    });

    it("writes the chain file's text to standard output when given no `--out`", async () => {
      const { state, load } = connectionTo(signer.did());
      const out = await captureOutput(() =>
        delegationIssueAction(options(signer.did()), load)
      );
      const [chain, ...rest] = decodeDelegationChains(out);
      expect(rest).toEqual([]);
      expect(chain).toHaveLength(1);
      expect((await decodeDelegation(chain[0])).payload).toMatchObject({
        iss: signer.did(),
        aud: agent.did(),
        sub: signer.did(),
      });
      expect(state.disposed).toBe(1);
    });

    it("throws for a space that is not a `did:key`, writing nothing and closing the connection", async () => {
      const space = "did:web:example.com";
      const { state, load } = connectionTo(space);
      let thrown: unknown;
      const out = await captureOutput(async () => {
        try {
          await delegationIssueAction(options(space), load);
        } catch (error) {
          thrown = error;
        }
      });
      expect(thrown).toEqual(
        new Error("The space did:web:example.com is not a did:key"),
      );
      expect(out).toBe("");
      expect(state.disposed).toBe(1);
    });
  });

  describe("delegationIssueAction() with --index or --index-root", () => {
    const INDEX = "https://index.test";
    let savedHome: string | undefined;
    let store: PatternIndexStore;
    let root: Identity;

    beforeEach(async () => {
      savedHome = Deno.env.get("CF_PATTERN_INDEX_HOME");
      Deno.env.set("CF_PATTERN_INDEX_HOME", join(dir, "index-home"));
      store = new PatternIndexStore(join(dir, "index-home", "index.test"));
      root = await store.createRootKey();
      await store.recordMembership({
        handle: "p-1",
        role: "user",
        root: root.did(),
      });
    });

    afterEach(() => {
      if (savedHome === undefined) {
        Deno.env.delete("CF_PATTERN_INDEX_HOME");
      } else {
        Deno.env.set("CF_PATTERN_INDEX_HOME", savedHome);
      }
    });

    /** A load that fails the test: an index delegation opens no space. */
    const noSpace = () => Promise.reject(new Error("opened a space"));

    it("writes an /index chain from the kept root to standard output, opening no space", async () => {
      const out = await captureOutput(() =>
        delegationIssueAction(
          { to: agent.did(), index: true, patternIndexUrl: INDEX },
          noSpace,
        )
      );
      const [chain, ...rest] = decodeDelegationChains(out);
      expect(rest).toEqual([]);
      expect((await decodeDelegation(chain[0])).payload).toMatchObject({
        iss: root.did(),
        aud: agent.did(),
        cmd: "/index",
      });
    });

    it("writes the chain to --out and reports it, with its expiry", async () => {
      const path = join(dir, "loom-index.json");
      const before = Math.floor(Date.now() / 1000);
      const out = await captureOutput(() =>
        delegationIssueAction({
          identity: keyPath,
          to: agent.did(),
          index: true,
          patternIndexUrl: INDEX,
          expiresIn: 3600,
          out: path,
        }, noSpace)
      );
      const [chain] = decodeDelegationChains(await Deno.readTextFile(path));
      const exp = (await decodeDelegation(chain[0])).payload.exp!;
      expect(exp - before).toBeGreaterThanOrEqual(3600);
      expect(out).toBe(
        `Wrote to ${path} a chain of 1 for /index from the index root ${root.did()} ending at ${agent.did()}, expiring ${
          new Date(exp * 1000).toISOString()
        }\n`,
      );
    });

    it("reports a root move written to --out as JSON with --json", async () => {
      const path = join(dir, "move.json");
      const out = await captureOutput(() =>
        delegationIssueAction({
          to: agent.did(),
          indexRoot: true,
          patternIndexUrl: INDEX,
          out: path,
          json: true,
        }, noSpace)
      );
      const [chain] = decodeDelegationChains(await Deno.readTextFile(path));
      const move = await decodeDelegation(chain[0]);
      expect(JSON.parse(out)).toEqual({
        out: path,
        command: "/index/root",
        root: root.did(),
        to: agent.did(),
        links: 1,
        expires: move.payload.exp,
      });
    });

    it("throws a usage error for --index with --index-root, writing nothing", async () => {
      let thrown: unknown;
      const out = await captureOutput(async () => {
        try {
          await delegationIssueAction({
            to: agent.did(),
            index: true,
            indexRoot: true,
          }, noSpace);
        } catch (error) {
          thrown = error;
        }
      });
      expect(thrown).toBeInstanceOf(ValidationError);
      expect(thrown).toMatchObject({
        message: "Pass --index or --index-root, not both.",
      });
      expect(out).toBe("");
    });
  });

  describe("cf delegation show", () => {
    const show = (path: string) =>
      captureOutput(() =>
        delegation.reset().throwErrors().parse(["show", path])
      );

    it("prints `No chains.` for a chain file that holds none", async () => {
      const path = join(dir, "none.json");
      await Deno.writeTextFile(path, encodeDelegationChains([]));
      expect(await show(path)).toBe("No chains.\n");
    });

    it("prints why a chain would not be presented in its rows' VERIFIED column, where a presentable one says `yes`", async () => {
      const expired = await issueDelegation(signer, {
        aud: agent.did(),
        sub: signer.did(),
        cmd: "/memory",
        pol: [],
        exp: 1,
      });
      const path = join(dir, "expired.json");
      await Deno.writeTextFile(path, encodeDelegationChains([[expired.bytes]]));
      const text = await show(path);
      expect(text).toContain(expired.cid);
      expect(text).toContain("no session presents the chain now");
      expect(text).not.toMatch(/\byes\b/);

      const live = await issueDelegation(signer, {
        aud: agent.did(),
        sub: signer.did(),
        cmd: "/memory",
        pol: [],
      });
      await Deno.writeTextFile(path, encodeDelegationChains([[live.bytes]]));
      const presentable = await show(path);
      expect(presentable).toContain(live.cid);
      expect(presentable).toMatch(/\byes\b/);
      expect(presentable).not.toContain("no session presents");
    });
  });
});
