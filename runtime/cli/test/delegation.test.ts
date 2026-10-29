import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { join, resolve } from "@std/path";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import {
  decodeDelegation,
  type DIDKey,
  encodeDelegationChains,
  Identity,
  issueDelegation,
  verifyDelegation,
} from "@commonfabric/identity";
import { isDIDKey } from "@commonfabric/identity/did";
import { MAX_PROOF_CHAIN_LENGTH } from "@commonfabric/memory/v2/session-open-auth";
import { StandaloneMemoryServer } from "@commonfabric/memory/v2/standalone";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/v2";

import { delegationsCause } from "../../runner/src/runtime.ts";
import { parseSpaceOptions } from "../commands/piece.ts";
import {
  DELEGATED_COMMAND,
  describeDelegationChains,
  holdDelegationChainFiles,
  issueDelegationChain,
  readDelegationChainFile,
} from "../lib/delegation.ts";
import { argv, cf, stripAnsi } from "./utils.ts";

// The key of a space that owns itself, the identity it delegated to when it
// was created, and the key that identity delegates to.
const spaceKey = await Identity.fromPassphrase("cli delegation space");
const core = await Identity.fromPassphrase("cli delegation core");
const agent = await Identity.fromPassphrase("cli delegation agent");
const other = await Identity.fromPassphrase("cli delegation other");
const space = spaceKey.did();

/** The delegation the space issued to `core` when it was created. */
const rootToCore = await issueDelegation(spaceKey, {
  aud: core.did(),
  sub: space,
  cmd: "/memory",
  pol: [],
});

const NOW = 1_800_000_000;

describe("delegation", () => {
  describe("issueDelegationChain()", () => {
    it("returns the delegation alone, from the signer to the audience over the space without expiry, when the signer holds no chain", async () => {
      const chain = await issueDelegationChain({
        signer: core,
        space,
        to: agent.did(),
        held: [],
        nowSeconds: NOW,
      });
      expect(chain).toHaveLength(1);
      const issued = await decodeDelegation(chain[0]);
      await verifyDelegation(issued);
      expect(issued.payload).toMatchObject({
        iss: core.did(),
        aud: agent.did(),
        sub: space,
        cmd: DELEGATED_COMMAND,
        pol: [],
        exp: null,
      });
    });

    it("puts the chain the signer holds before the delegation it issues", async () => {
      const chain = await issueDelegationChain({
        signer: core,
        space,
        to: agent.did(),
        held: [rootToCore.bytes],
        nowSeconds: NOW,
      });
      expect(chain).toHaveLength(2);
      expect(chain[0]).toEqual(rootToCore.bytes);
      const issued = await decodeDelegation(chain[1]);
      expect(issued.payload).toMatchObject({
        iss: core.did(),
        aud: agent.did(),
        sub: space,
      });
    });

    it("lets a key delegated to in turn delegate onward, keeping every link before its own", async () => {
      const toAgent = await issueDelegationChain({
        signer: core,
        space,
        to: agent.did(),
        held: [rootToCore.bytes],
        nowSeconds: NOW,
      });
      const onward = await issueDelegationChain({
        signer: agent,
        space,
        to: other.did(),
        held: toAgent,
        nowSeconds: NOW,
      });
      expect(onward).toHaveLength(3);
      expect(onward.slice(0, 2)).toEqual(toAgent);
      const issued = await decodeDelegation(onward[2]);
      expect(issued.payload).toMatchObject({
        iss: agent.did(),
        aud: other.did(),
        sub: space,
      });
    });

    it("sets the expiry given", async () => {
      const [bytes] = await issueDelegationChain({
        signer: core,
        space,
        to: agent.did(),
        held: [],
        expiresAt: NOW + 60,
        nowSeconds: NOW,
      });
      expect((await decodeDelegation(bytes)).payload.exp).toBe(NOW + 60);
    });

    it("throws for an audience that is not an ed25519 did:key", async () => {
      await expect(issueDelegationChain({
        signer: core,
        space,
        to: "did:key:nope" as DIDKey,
        held: [],
      })).rejects.toThrow('"did:key:nope" is not an ed25519 did:key');
    });

    it("throws for the signer as its own audience", async () => {
      await expect(issueDelegationChain({
        signer: core,
        space,
        to: core.did(),
        held: [],
      })).rejects.toThrow("the audience is the issuing key itself");
    });

    it("throws for an expiry that is not after now", async () => {
      await expect(issueDelegationChain({
        signer: core,
        space,
        to: agent.did(),
        held: [],
        expiresAt: NOW,
        nowSeconds: NOW,
      })).rejects.toThrow("the expiry is not after now");
    });

    it("throws for a held chain that does not end at the signer", async () => {
      await expect(issueDelegationChain({
        signer: agent,
        space,
        to: other.did(),
        held: [rootToCore.bytes],
      })).rejects.toThrow("the held chain does not end at the signer");
    });

    it("throws for a held chain already as long as a holder may present, signing nothing", async () => {
      // A chain of the longest length a holder presents, from the space's
      // key through intermediaries to the signer.
      const keys = await Promise.all(
        Array.from(
          { length: MAX_PROOF_CHAIN_LENGTH - 1 },
          (_, i) => Identity.fromPassphrase(`cli delegation link ${i}`),
        ),
      );
      const held: Uint8Array[] = [];
      let issuer = spaceKey;
      for (const next of [...keys, core]) {
        const link = await issueDelegation(issuer, {
          aud: next.did(),
          sub: space,
          cmd: "/memory",
          pol: [],
        });
        held.push(link.bytes);
        issuer = next;
      }
      expect(held).toHaveLength(MAX_PROOF_CHAIN_LENGTH);
      await expect(issueDelegationChain({
        signer: core,
        space,
        to: agent.did(),
        held,
      })).rejects.toThrow(
        `the chain would be longer than ${MAX_PROOF_CHAIN_LENGTH} delegations`,
      );
      // One link shorter, the chain's last key issues onward.
      const chain = await issueDelegationChain({
        signer: keys[keys.length - 1],
        space,
        to: agent.did(),
        held: held.slice(0, -1),
      });
      expect(chain).toHaveLength(MAX_PROOF_CHAIN_LENGTH);
    });

    it("throws for a held chain whose last link does not decode", async () => {
      await expect(issueDelegationChain({
        signer: core,
        space,
        to: agent.did(),
        held: [new Uint8Array([1, 2, 3])],
      })).rejects.toThrow();
    });
  });

  describe("describeDelegationChains()", () => {
    it("describes each link of a chain a runtime would hold, with its position and CID", async () => {
      const chain = await issueDelegationChain({
        signer: core,
        space,
        to: agent.did(),
        held: [rootToCore.bytes],
        expiresAt: NOW + 60,
        nowSeconds: NOW,
      });
      const rows = await describeDelegationChains([chain], NOW);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        chain: 0,
        link: 0,
        cid: rootToCore.cid,
        issuer: space,
        audience: core.did(),
        subject: space,
        command: "/memory",
        expires: null,
        verified: true,
      });
      expect(rows[1]).toMatchObject({
        chain: 0,
        link: 1,
        issuer: core.did(),
        audience: agent.did(),
        expires: NOW + 60,
        verified: true,
      });
    });

    it("puts on every row of a chain a runtime would refuse why, and describes the links", async () => {
      const [fromCore] = await issueDelegationChain({
        signer: core,
        space,
        to: agent.did(),
        held: [],
      });
      const toOther = await issueDelegation(spaceKey, {
        aud: other.did(),
        sub: space,
        cmd: "/memory",
        pol: [],
      });
      const rows = await describeDelegationChains([[toOther.bytes, fromCore]]);
      expect(rows.map((row) => row.verified)).toEqual([
        "delegation 1 is not issued by the previous audience",
        "delegation 1 is not issued by the previous audience",
      ]);
      expect(rows[0]).toMatchObject({
        cid: toOther.cid,
        audience: other.did(),
      });
    });

    it("says a chain over two spaces would be refused, which no link shows on its own", async () => {
      const overOther = await issueDelegation(core, {
        aud: agent.did(),
        sub: other.did(),
        cmd: "/memory",
        pol: [],
      });
      const rows = await describeDelegationChains([
        [rootToCore.bytes, overOther.bytes],
      ]);
      expect(rows.map((row) => row.verified)).toEqual([
        "the chain is over more than one space",
        "the chain is over more than one space",
      ]);
    });

    it("says a chain whose link has expired would not be presented, and calls it verified before then", async () => {
      const chain = await issueDelegationChain({
        signer: core,
        space,
        to: agent.did(),
        held: [rootToCore.bytes],
        expiresAt: NOW + 60,
        nowSeconds: NOW,
      });
      const after = await describeDelegationChains([chain], NOW + 61);
      expect(after.map((row) => row.verified)).toEqual([
        expect.stringContaining("no session presents the chain now"),
        expect.stringContaining("no session presents the chain now"),
      ]);
      const before = await describeDelegationChains([chain], NOW + 60);
      expect(before.map((row) => row.verified)).toEqual([true, true]);
    });

    it("says a chain whose link is not yet valid would not be presented", async () => {
      const notYet = await issueDelegation(spaceKey, {
        aud: core.did(),
        sub: space,
        cmd: "/memory",
        pol: [],
        nbf: NOW + 60,
      });
      const rows = await describeDelegationChains([[notYet.bytes]], NOW);
      expect(rows[0].verified).toContain("no session presents the chain now");
    });

    it("says why a link does not decode, and describes the next chain", async () => {
      const rows = await describeDelegationChains([
        [new Uint8Array([1, 2, 3])],
        [rootToCore.bytes],
      ]);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ chain: 0, link: 0, cid: "" });
      expect(typeof rows[0].verified).toBe("string");
      expect(rows[1]).toMatchObject({ chain: 1, link: 0, verified: true });
    });
  });

  describe("chain files", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await Deno.makeTempDir({ prefix: "cf-delegation-" });
    });

    afterEach(async () => {
      await Deno.remove(dir, { recursive: true });
    });

    /** Writes `chains` as a chain file in `dir` and returns its path. */
    const chainFile = async (
      name: string,
      chains: readonly (readonly Uint8Array[])[],
    ): Promise<string> => {
      const path = join(dir, name);
      await Deno.writeTextFile(path, encodeDelegationChains(chains));
      return path;
    };

    /** Records what it is handed. */
    const holder = () => {
      const held: (readonly Uint8Array[])[] = [];
      return {
        held,
        addDelegationChain: (chain: readonly Uint8Array[]) => {
          held.push(chain);
          return Promise.resolve();
        },
      };
    };

    it("reads the chains a file holds", async () => {
      const path = await chainFile("one.json", [[rootToCore.bytes]]);
      expect(await readDelegationChainFile(path)).toEqual([
        [rootToCore.bytes],
      ]);
    });

    it("throws naming a file that cannot be read", async () => {
      const path = join(dir, "missing.json");
      await expect(readDelegationChainFile(path)).rejects.toThrow(
        `Could not read the delegation chain file ${path}`,
      );
    });

    it("throws naming a file that is not a chain file", async () => {
      const path = join(dir, "other.json");
      await Deno.writeTextFile(path, "{}");
      await expect(readDelegationChainFile(path)).rejects.toThrow(
        `${path} is not a delegation chain file: the chain text names a format other than`,
      );
    });

    it("hands the holder every chain of every file in order, and returns how many", async () => {
      const toAgent = await issueDelegationChain({
        signer: core,
        space,
        to: agent.did(),
        held: [rootToCore.bytes],
      });
      const toAgentElsewhere = await issueDelegationChain({
        signer: other,
        space: other.did(),
        to: agent.did(),
        held: [],
      });
      const first = await chainFile("first.json", [toAgent]);
      const second = await chainFile("second.json", [toAgentElsewhere]);
      const recorder = holder();
      expect(
        await holdDelegationChainFiles(recorder, [first, second], agent.did()),
      ).toBe(2);
      expect(recorder.held).toEqual([toAgent, toAgentElsewhere]);
    });

    it("throws for a holder whose sessions present no chain, reading nothing", async () => {
      const path = join(dir, "missing.json");
      await expect(holdDelegationChainFiles({}, [path], agent.did())).rejects
        .toThrow("sessions present no proof chain");
      expect(await holdDelegationChainFiles({}, [], agent.did())).toBe(0);
    });

    it("throws naming the file and the chain that ends at another key, holding nothing from it", async () => {
      const toAgent = await issueDelegationChain({
        signer: core,
        space,
        to: agent.did(),
        held: [rootToCore.bytes],
      });
      const path = await chainFile("agent.json", [toAgent]);
      const recorder = holder();
      await expect(holdDelegationChainFiles(recorder, [path], core.did()))
        .rejects.toThrow(
          `Chain 0 of ${path} cannot be held: it ends at ${agent.did()}, not at the identity ${core.did()}`,
        );
      expect(recorder.held).toEqual([]);
    });

    it("throws naming the file and the chain no session presents now, holding nothing from it", async () => {
      const toAgent = await issueDelegationChain({
        signer: core,
        space,
        to: agent.did(),
        held: [rootToCore.bytes],
        expiresAt: NOW + 60,
        nowSeconds: NOW,
      });
      const path = await chainFile("expired.json", [toAgent]);
      const recorder = holder();
      await expect(
        holdDelegationChainFiles(recorder, [path], agent.did(), NOW + 61),
      ).rejects.toThrow(
        `Chain 0 of ${path} cannot be held: no session presents the chain now`,
      );
      expect(recorder.held).toEqual([]);
      expect(
        await holdDelegationChainFiles(recorder, [path], agent.did(), NOW),
      ).toBe(1);
    });

    it("throws naming the file and the chain the holder refuses, after handing it the chains before", async () => {
      const path = await chainFile("two.json", [
        [rootToCore.bytes],
        [rootToCore.bytes],
      ]);
      const refusing = {
        count: 0,
        addDelegationChain(_chain: readonly Uint8Array[]) {
          refusing.count += 1;
          return refusing.count === 2
            ? Promise.reject(new Error("the chain is over no space"))
            : Promise.resolve();
        },
      };
      await expect(holdDelegationChainFiles(refusing, [path], core.did()))
        .rejects.toThrow(
          `Chain 1 of ${path} cannot be held: the chain is over no space`,
        );
      expect(refusing.count).toBe(2);
    });

    describe("cf delegation show", () => {
      it("describes the chains a file holds, one row per link", async () => {
        const toAgent = await issueDelegationChain({
          signer: core,
          space,
          to: agent.did(),
          held: [rootToCore.bytes],
        });
        const path = await chainFile("agent.json", [toAgent]);
        const { code, stdout } = await cf(argv`delegation show ${path}`);
        expect(code).toBe(0);
        const text = stdout.map(stripAnsi).join("\n");
        expect(text).toContain(rootToCore.cid);
        expect(text).toContain(agent.did());
        expect(text).toContain("never");
      });

      it("prints the rows as JSON with --json", async () => {
        const path = await chainFile("root.json", [[rootToCore.bytes]]);
        const { code, stdout } = await cf(
          argv`delegation show ${path} --json`,
        );
        expect(code).toBe(0);
        expect(JSON.parse(stdout.join("\n"))).toEqual([{
          chain: 0,
          link: 0,
          cid: rootToCore.cid,
          issuer: space,
          audience: core.did(),
          subject: space,
          command: "/memory",
          expires: null,
          verified: true,
        }]);
      });

      it("prints an expiry beyond what a date represents as its unix second", async () => {
        const far = 10 ** 14;
        const [bytes] = await issueDelegationChain({
          signer: core,
          space,
          to: agent.did(),
          held: [],
          expiresAt: far,
        });
        const path = await chainFile("far.json", [[bytes]]);
        const { code, stdout } = await cf(argv`delegation show ${path}`);
        expect(code).toBe(0);
        expect(stdout.map(stripAnsi).join("\n")).toContain(String(far));
      });

      it("exits non-zero naming a file that is not a chain file", async () => {
        const path = join(dir, "other.json");
        await Deno.writeTextFile(path, "[]");
        const { code, stderr } = await cf(argv`delegation show ${path}`);
        expect(code).not.toBe(0);
        expect(stderr.map(stripAnsi).join("\n")).toContain(
          `${path} is not a delegation chain file`,
        );
      });
    });
  });

  describe("against a memory server", () => {
    // A server whose access lists are enforced, a profile space on it that
    // owns itself and grants nobody else, its owner, whose Home records the
    // delegation the space issued to it as the runtime records one, and two
    // keys delegated to in turn. Each `cf` runs as a process of its own
    // against the server's address.
    let server: StandaloneMemoryServer;
    let dir: string;
    let profile: DIDKey;
    let profileToOwner: Uint8Array;
    let keys: Record<"owner" | "agent" | "third", Identity>;

    /** The key file of `name`, written in `beforeEach`. */
    const keyFile = (name: keyof typeof keys) => join(dir, `${name}.key`);

    /** A new key, written to `name`'s key file. */
    const newKey = async (name: keyof typeof keys) => {
      const pkcs8 = await Identity.generatePkcs8();
      await Deno.writeFile(keyFile(name), pkcs8);
      return await Identity.fromPkcs8(pkcs8);
    };

    /** Runs `cf` with `args`, then the identity and target flags of `as`. */
    const cfAs = (as: keyof typeof keys, args: readonly string[]) =>
      cf([
        ...args,
        ...argv`-i ${keyFile(as)} -a ${server.url.href} -s ${profile}`,
      ]);

    /** The output of a `cf` run, without its colors, as one string. */
    const textOf = (lines: readonly string[]) =>
      lines.map(stripAnsi).join("\n");

    beforeEach(async () => {
      server = StandaloneMemoryServer.start({
        acl: { mode: "enforce", delegations: true },
      });
      dir = await Deno.makeTempDir({ prefix: "cf-delegation-server-" });
      keys = {
        owner: await newKey("owner"),
        agent: await newKey("agent"),
        third: await newKey("third"),
      };
      const owner = keys.owner;
      const manager = StorageManager.open({
        as: owner,
        memoryHost: server.url,
      });
      const runtime = new Runtime({
        apiUrl: server.url,
        storageManager: manager,
      });
      try {
        const created = await manager.createSelfOwnedSpace({
          delegateTo: owner.did(),
        });
        if (!isDIDKey(created.space)) {
          throw new Error(`The profile ${created.space} is not a did:key`);
        }
        profile = created.space;
        profileToOwner = created.delegation;
        const { error } = await runtime.editWithRetry((tx) => {
          runtime.getHomeSpaceCell(tx).key("defaultPattern").set({
            profiles: [runtime.getCell(profile, "profile", undefined, tx)],
          });
          runtime.getCell(
            owner.did(),
            delegationsCause(profile),
            undefined,
            tx,
          ).set({ delegations: [new FabricBytes(profileToOwner)] });
        });
        expect(error).toBeUndefined();
        await runtime.storageManager.synced();
      } finally {
        await runtime.dispose();
      }
    });

    afterEach(async () => {
      await server.close();
      await Deno.remove(dir, { recursive: true });
    });

    it("issues the agent a chain behind the delegation the owner's Home records, with which the agent opens the profile it is refused without", async () => {
      const agentFile = join(dir, "agent.json");
      const issued = await cfAs(
        "owner",
        argv`delegation issue --to ${keys.agent.did()} --out ${agentFile} --json`,
      );
      expect(issued.code).toBe(0);
      expect(JSON.parse(issued.stdout.join("\n"))).toEqual({
        out: agentFile,
        space: profile,
        to: keys.agent.did(),
        links: 2,
      });
      const [chain] = await readDelegationChainFile(agentFile);
      expect((await decodeDelegation(chain[0])).payload).toMatchObject({
        iss: profile,
        aud: keys.owner.did(),
      });

      const refused = await cfAs("agent", argv`piece ls`);
      expect(refused.code).not.toBe(0);
      expect(textOf(refused.stderr)).toContain("lacks READ");
      const opened = await cfAs(
        "agent",
        argv`piece ls --delegations ${agentFile}`,
      );
      expect(opened.code).toBe(0);
    });

    it("lets the agent issue onward from its chain file, and the third key opens the profile with the chain it is handed", async () => {
      const agentFile = join(dir, "agent.json");
      const thirdFile = join(dir, "third.json");
      expect(
        (await cfAs(
          "owner",
          argv`delegation issue --to ${keys.agent.did()} --out ${agentFile}`,
        )).code,
      ).toBe(0);
      const onward = await cfAs(
        "agent",
        argv`delegation issue --to ${keys.third.did()} --out ${thirdFile} --delegations ${agentFile}`,
      );
      expect(onward.code).toBe(0);
      const [chain] = await readDelegationChainFile(thirdFile);
      expect(chain.slice(0, 2)).toEqual(
        (await readDelegationChainFile(agentFile))[0],
      );
      expect(chain).toHaveLength(3);

      const opened = await cfAs(
        "third",
        argv`piece ls --delegations ${thirdFile}`,
      );
      expect(opened.code).toBe(0);
    });

    it("fails a command naming a chain file whose chain has expired, naming the file", async () => {
      const expired = await issueDelegation(keys.owner, {
        aud: keys.agent.did(),
        sub: profile,
        cmd: "/memory",
        pol: [],
        exp: Math.floor(Date.now() / 1000) - 1,
      });
      const expiredFile = join(dir, "expired.json");
      await Deno.writeTextFile(
        expiredFile,
        encodeDelegationChains([[profileToOwner, expired.bytes]]),
      );

      const failed = await cfAs(
        "agent",
        argv`piece ls --delegations ${expiredFile}`,
      );
      expect(failed.code).not.toBe(0);
      expect(textOf(failed.stderr)).toContain(
        `Chain 0 of ${expiredFile} cannot be held: no session presents the chain now`,
      );
    });
  });

  describe("the --delegations option", () => {
    const target = {
      identity: "me.key",
      apiUrl: "https://toolshed.test",
      space: "did:key:z6Mkspace",
      explicitSpace: true,
    };

    it("is carried as absolute paths, from one path CF_DELEGATIONS gives", () => {
      const config = parseSpaceOptions({ ...target, delegations: "a.json" });
      expect(config.delegations).toEqual([resolve("a.json")]);
    });

    it("is carried as absolute paths, from each path --delegations gives", () => {
      const config = parseSpaceOptions({
        ...target,
        delegations: ["a.json", "/abs/b.json"],
      });
      expect(config.delegations).toEqual([resolve("a.json"), "/abs/b.json"]);
    });

    it("is absent when none is given", () => {
      expect(parseSpaceOptions(target).delegations).toBeUndefined();
    });

    it("is refused by a command that acts on no existing space", async () => {
      const { code, stderr } = await cf(
        argv`space create --delegations a.json`,
      );
      expect(code).not.toBe(0);
      expect(stderr.map(stripAnsi).join("\n")).toContain(
        'Unknown option "--delegations"',
      );
    });
  });
});
