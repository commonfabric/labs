import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { ValidationError } from "@cliffy/command";
import { encodeDelegationChains, Identity } from "@commonfabric/identity";
import { PatternIndexError } from "@commonfabric/pattern-index/client";
import {
  issueIndexChain,
  issueRootMove,
} from "@commonfabric/pattern-index/membership";
import { PatternIndexStore } from "@commonfabric/pattern-index/store";
import type { JoinResult } from "@commonfabric/pattern-index/join";
import {
  admit,
  type IndexDeps,
  join as joinIndex,
  joinReport,
  moveRoot,
  requireIdentityPath,
  rethrowAsNotMember,
  sharing,
  whoami,
} from "../commands/pattern-index.ts";
import { FakePatternIndex } from "../../pattern-index/test/fake-pattern-index.ts";

const BASE = "https://index.test";
const LINK = `${BASE}/join?invite=inv-1#code=secret-code`;
const reported = await Identity.fromPassphrase("pattern index report");

/** A stream holding `text`, as piped standard input would. */
const streamOf = (text: string): ReadableStream<Uint8Array> =>
  ReadableStream.from([new TextEncoder().encode(text)]);

describe("pattern-index", () => {
  let dir: string;
  let keyPath: string;
  let signer: Identity;
  let index: FakePatternIndex;
  let store: PatternIndexStore;
  let rendered: { value: unknown; json?: boolean }[];
  let deps: IndexDeps;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "cf-pattern-index-" });
    keyPath = join(dir, "me.key");
    const pkcs8 = await Identity.generatePkcs8();
    await Deno.writeFile(keyPath, pkcs8);
    signer = await Identity.fromPkcs8(pkcs8);
    index = new FakePatternIndex({ invites: { "inv-1": "secret-code" } });
    store = new PatternIndexStore(join(dir, "store"));
    rendered = [];
    deps = {
      fetchFn: index.fetchFn,
      store,
      render: (value, options) => {
        rendered.push({ value, json: options?.json });
      },
    };
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  const options = (extra: Record<string, unknown> = {}) => ({
    identity: keyPath,
    patternIndexUrl: BASE,
    ...extra,
  });

  describe("requireIdentityPath()", () => {
    it("returns the keyfile named", () => {
      expect(requireIdentityPath({ identity: "./me.key" })).toBe("./me.key");
    });

    it("throws a usage error naming --identity when none or an empty one is named", () => {
      for (const identity of [undefined, ""]) {
        expect(() => requireIdentityPath({ identity })).toThrow(
          ValidationError,
        );
        expect(() => requireIdentityPath({ identity })).toThrow(
          "--identity <keyfile>",
        );
      }
    });
  });

  describe("rethrowAsNotMember()", () => {
    it("throws what to do about a refusal of the identity, for 401 and 403", () => {
      for (const status of [401, 403]) {
        expect(() =>
          rethrowAsNotMember(new PatternIndexError("whoami", status))
        ).toThrow("does not know this identity as a member");
      }
    });

    it("throws any other failure as it is", () => {
      const other = new PatternIndexError("whoami", 500);
      expect(() => rethrowAsNotMember(other)).toThrow(other);
      const plain = new Error("offline");
      expect(() => rethrowAsNotMember(plain)).toThrow(plain);
    });
  });

  describe("joinReport()", () => {
    const result: JoinResult = {
      handle: "p-1",
      role: "user",
      root: reported.did(),
      signer: reported.did(),
      joined: true,
      storeDir: "/state/index.test",
      rootKeptHere: true,
    };

    it("returns who joined and to back up the directory holding the root", () => {
      expect(joinReport(result).split("\n")).toEqual([
        "Joined the pattern index as p-1.",
        "Back up /state/index.test: it holds the key your membership is rooted at, and with it your standing on the index.",
        expect.stringContaining("pattern publish <entry file>"),
      ]);
    });

    it("returns that the identity was already a member, and that the root is kept elsewhere", () => {
      const lines = joinReport({
        ...result,
        joined: false,
        rootKeptHere: false,
      }).split("\n");
      expect(lines[0]).toBe(
        "Already a member of the pattern index as p-1.",
      );
      expect(lines[1]).toContain("not the root itself");
      expect(lines.join("\n")).not.toContain("/state/index.test");
    });
  });

  describe("join()", () => {
    it("redeems the invite link passed, keeps the new root in the store, and prints the report", async () => {
      await joinIndex(options(), LINK, deps);

      expect(rendered).toHaveLength(1);
      expect(rendered[0].json).toBeUndefined();
      expect(String(rendered[0].value)).toContain(
        "Joined the pattern index as p-1.",
      );
      expect(String(rendered[0].value)).toContain(`Back up ${store.dir}`);
      expect((await store.membership())?.handle).toBe("p-1");
      expect(index.calls.map((call) => call.fn)).toContain("redeemInvite");
    });

    it("reads the invite link from standard input when none is passed, and prints JSON with --json", async () => {
      await joinIndex(options({ json: true }), undefined, {
        ...deps,
        stdin: streamOf(`${LINK}\n`),
      });

      expect(rendered[0].json).toBe(true);
      expect(rendered[0].value).toMatchObject({
        handle: "p-1",
        signer: signer.did(),
        joined: true,
        rootKeptHere: true,
      });
    });

    it("throws a usage error for empty standard input, redeeming nothing", async () => {
      await expect(
        joinIndex(options(), undefined, { ...deps, stdin: streamOf(" \n") }),
      ).rejects.toThrow("pipe it on stdin");
      expect(index.calls).toEqual([]);
      expect(rendered).toEqual([]);
    });

    it("throws a usage error for an invite link together with --chain", async () => {
      await expect(
        joinIndex(options({ chain: join(dir, "chain.json") }), LINK, deps),
      ).rejects.toThrow("not both");
      expect(index.calls).toEqual([]);
    });

    it("adopts the one chain a --chain file holds, from a root kept elsewhere", async () => {
      const root = await Identity.generate();
      index.admit(root.did(), "p-elsewhere");
      const chainPath = join(dir, "chain.json");
      await Deno.writeTextFile(
        chainPath,
        encodeDelegationChains([
          await issueIndexChain({ issuer: root, to: signer.did(), held: [] }),
        ]),
      );

      await joinIndex(options({ chain: chainPath }), undefined, deps);

      const text = String(rendered[0].value);
      expect(text).toContain("Joined the pattern index as p-elsewhere.");
      expect(text).toContain("not the root itself");
      expect((await store.membership())?.root).toBe(root.did());
    });

    it("reads the chain from stdin for --chain -", async () => {
      const root = await Identity.generate();
      index.admit(root.did(), "p-piped");
      const text = encodeDelegationChains([
        await issueIndexChain({ issuer: root, to: signer.did(), held: [] }),
      ]);

      await joinIndex(options({ chain: "-" }), undefined, {
        ...deps,
        stdin: new Blob([text]).stream(),
      });

      expect(String(rendered[0].value)).toContain(
        "Joined the pattern index as p-piped.",
      );
      expect((await store.membership())?.root).toBe(root.did());
    });

    it("throws for a --chain file that does not hold exactly one chain", async () => {
      const root = await Identity.generate();
      const chain = await issueIndexChain({
        issuer: root,
        to: signer.did(),
        held: [],
      });
      const chainPath = join(dir, "chains.json");
      await Deno.writeTextFile(
        chainPath,
        encodeDelegationChains([chain, chain]),
      );

      await expect(
        joinIndex(options({ chain: chainPath }), undefined, deps),
      ).rejects.toThrow(`${chainPath} holds 2 chains`);
      expect(await store.membership()).toBeUndefined();
    });
  });

  describe("whoami()", () => {
    it("prints the member's handle and role and the DID it signs as", async () => {
      index.admit(signer.did(), "p-me");
      await whoami(options(), deps);
      expect(rendered[0].value).toBe(`p-me (user), signing as ${signer.did()}`);
    });

    it("prints the member and the signer as JSON with --json", async () => {
      index.admit(signer.did(), "p-me");
      await whoami(options({ json: true }), deps);
      expect(rendered[0]).toEqual({
        value: { handle: "p-me", role: "user", signer: signer.did() },
        json: true,
      });
    });

    it("throws what to do for an identity the index does not know", async () => {
      await expect(whoami(options(), deps)).rejects.toThrow(
        "join with your invite link",
      );
      expect(rendered).toEqual([]);
    });
  });

  describe("admit()", () => {
    /** The fake index, also answering `admitKey` as an admin's call. */
    const admitting = (bodies: unknown[]): IndexDeps => ({
      ...deps,
      fetchFn: async (input, init) => {
        if (String(input).endsWith("/admitKey")) {
          bodies.push(JSON.parse(String(init?.body)));
          return Response.json({ handle: "p-9", role: "user" });
        }
        return await index.fetchFn(input, init);
      },
    });

    it("admits the DID and prints the handle it was given", async () => {
      const newcomer = await Identity.generate();
      const bodies: unknown[] = [];
      await admit(options(), newcomer.did(), admitting(bodies));

      expect(bodies).toEqual([expect.objectContaining({
        did: newcomer.did(),
      })]);
      expect(rendered[0].value).toBe(
        `Admitted ${newcomer.did()} as p-9 (user).`,
      );
    });

    it("prints the member and the DID as JSON with --json", async () => {
      const newcomer = await Identity.generate();
      await admit(options({ json: true }), newcomer.did(), admitting([]));
      expect(rendered[0].value).toEqual({
        handle: "p-9",
        role: "user",
        did: newcomer.did(),
      });
    });

    it("throws a usage error for a DID that is not an ed25519 did:key, calling nothing", async () => {
      const bodies: unknown[] = [];
      await expect(
        admit(options(), "did:web:example.com", admitting(bodies)),
      ).rejects.toThrow('"did:web:example.com" is not an ed25519 did:key.');
      expect(bodies).toEqual([]);
      expect(index.calls).toEqual([]);
    });
  });

  describe("moveRoot()", () => {
    it("presents the root move, records the identity as the root, and prints what changed", async () => {
      const root = await Identity.generate();
      index.admit(root.did(), "p-moving");
      const file = join(dir, "move.json");
      const move = await issueRootMove({ root, to: signer.did() });
      await Deno.writeTextFile(file, encodeDelegationChains([[move.bytes]]));

      await moveRoot(options(), file, deps);

      expect(rendered[0].value).toBe(
        `p-moving is now rooted at ${signer.did()}. Chains issued from the old root no longer work; issue new ones with cf delegation issue --index.`,
      );
      expect((await store.membership())?.root).toBe(signer.did());
    });

    it("prints the result as JSON with --json", async () => {
      const root = await Identity.generate();
      index.admit(root.did(), "p-moving");
      const file = join(dir, "move.json");
      const move = await issueRootMove({ root, to: signer.did() });
      await Deno.writeTextFile(file, encodeDelegationChains([[move.bytes]]));

      await moveRoot(options({ json: true }), file, deps);

      expect(rendered[0]).toMatchObject({
        value: { handle: "p-moving", root: signer.did() },
        json: true,
      });
    });

    it("throws a usage error for a file that does not hold a single one-link chain", async () => {
      const root = await Identity.generate();
      const chain = await issueIndexChain({
        issuer: root,
        to: signer.did(),
        held: [],
      });
      const file = join(dir, "two.json");
      for (const chains of [[], [chain, chain], [[...chain, ...chain]]]) {
        await Deno.writeTextFile(file, encodeDelegationChains(chains));
        await expect(moveRoot(options(), file, deps)).rejects.toThrow(
          `${file} does not hold one root-move delegation`,
        );
      }
      expect(index.calls).toEqual([]);
    });
  });

  describe("sharing()", () => {
    const SETTINGS = {
      enabled: true,
      selfBuilt: false,
      receivesAnonymous: true,
      updatedAt: null,
    };

    /**
     * The fake index, also answering the sharing calls, as it would a member's
     * when `member` and refusing them otherwise.
     */
    const sharingIndex = (
      bodies: { fn: string; body: unknown }[],
      member = true,
    ): IndexDeps => ({
      ...deps,
      fetchFn: async (input, init) => {
        const fn = String(input).split("/").at(-1)!;
        if (fn !== "getSharingSettings" && fn !== "setSharingSettings") {
          return await index.fetchFn(input, init);
        }
        if (!member) {
          return Response.json({ error: "not a member" }, { status: 403 });
        }
        const body = JSON.parse(String(init?.body));
        bodies.push({ fn, body });
        return Response.json({ ...SETTINGS, ...body });
      },
    });

    it("reads the setting when no switch is named, and prints what it means", async () => {
      const bodies: { fn: string; body: unknown }[] = [];
      await sharing(options(), undefined, sharingIndex(bodies));

      expect(bodies).toEqual([{ fn: "getSharingSettings", body: {} }]);
      expect(String(rendered[0].value).split("\n")).toEqual([
        expect.stringContaining("Sharing: on."),
        expect.stringContaining("kept private unless you run cf pattern share"),
      ]);
    });

    it("changes only the switches named, and prints the new setting as JSON with --json", async () => {
      const bodies: { fn: string; body: unknown }[] = [];
      await sharing(
        options({ json: true, selfBuilt: "on" }),
        "off",
        sharingIndex(bodies),
      );

      expect(bodies).toEqual([{
        fn: "setSharingSettings",
        body: { enabled: false, selfBuilt: true },
      }]);
      expect(rendered).toEqual([{
        value: { ...SETTINGS, enabled: false, selfBuilt: true },
        json: true,
      }]);
    });

    it("throws a usage error for a switch that is not on or off, calling nothing", async () => {
      await expect(sharing(options(), "maybe", deps)).rejects.toThrow(
        ValidationError,
      );
      expect(index.calls).toEqual([]);
    });

    it("throws what to do for an identity the index does not know, printing nothing", async () => {
      await expect(sharing(options(), undefined, sharingIndex([], false)))
        .rejects
        .toThrow("join with your invite link");
      expect(rendered).toEqual([]);
    });
  });
});
