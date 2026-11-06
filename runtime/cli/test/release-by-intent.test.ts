import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import { cfcCanonicalClauseDigest } from "@commonfabric/memory/v2/cfc-clause-identity";
import { parseOwnerReleaseByIntentRecord } from "@commonfabric/memory/v2/cfc-owner-release-by-intent";
import { type Cell, Runtime } from "@commonfabric/runner";
import { readStoredCfcMetadata } from "@commonfabric/runner/cfc";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  type ReleasableClause,
  releaseCellConfidentialityByIntent,
  resolveClauseSelectors,
} from "../lib/piece.ts";
import { releaseCellConfidentialityByIntentFromCommand } from "../commands/piece.ts";
import { cell } from "../commands/cell.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cf-cell-release-by-intent");
const owner = signer.did();
const pieceConfig = {
  apiUrl: "https://example.com",
  identity: "/unused.key",
  space: owner,
  piece: "piece",
};

const own = cfcAtom.personalSpace(owner);
const others = [
  cfcAtom.personalSpace("did:key:z6MkReleaseOtherA"),
  cfcAtom.personalSpace("did:key:z6MkReleaseOtherB"),
];

describe("cf cell release-by-intent", () => {
  describe("resolveClauseSelectors()", () => {
    const clause = (digest: string): ReleasableClause => ({
      digest,
      clause: digest,
      positions: [{ origin: "derived" }],
    });
    const clauses = [clause("abc123"), clause("abd456"), clause("xyz789")];

    it("returns the digest a whole digest or an unambiguous prefix names, each once", () => {
      expect(resolveClauseSelectors(["abc123", "abd", "abc"], clauses))
        .toEqual(["abc123", "abd456"]);
    });

    it("throws on a prefix beginning two digests, naming them", () => {
      expect(() => resolveClauseSelectors(["ab"], clauses)).toThrow(
        "`ab` is ambiguous: it begins `abc123`, `abd456`",
      );
    });

    it("throws on a selector beginning no digest, or an empty one", () => {
      expect(() => resolveClauseSelectors(["q"], clauses)).toThrow(
        "beginning `q`",
      );
      expect(() => resolveClauseSelectors([""], clauses)).toThrow(
        "beginning ``",
      );
    });
  });

  it("is `cf cell release-by-intent`, routed to its action", () => {
    const command = cell.getCommand("release-by-intent", true) as unknown as {
      actionHandler?: unknown;
    };
    expect(command.actionHandler).toBe(
      releaseCellConfidentialityByIntentFromCommand,
    );
  });

  it("refuses with standard input not a terminal, before loading or signing anything", async () => {
    let loaded = false;
    await expect(
      releaseCellConfidentialityByIntent(pieceConfig, [], ["abc"], {}, {
        isStdinTerminal: () => false,
        loadPieces: () => {
          loaded = true;
          return Promise.reject(new Error("loaded"));
        },
        loadIdentity: () => {
          loaded = true;
          return Promise.reject(new Error("loaded"));
        },
      }),
    ).rejects.toThrow("standard input is not one");
    expect(loaded).toBe(false);
  });

  describe("against a stored result", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let root: Cell<unknown>;
    let signed: number;
    let deps: Parameters<typeof releaseCellConfidentialityByIntent>[4];

    /** The stored payload entries of `root`. */
    const storedEntries = () => {
      const tx = runtime.edit();
      try {
        return readStoredCfcMetadata(tx, root.getAsNormalizedFullLink())
          ?.labelMap.entries;
      } finally {
        tx.abort();
      }
    };

    beforeEach(async () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      root = runtime.getCell<unknown>(owner, "cf-cell-release-by-intent-root");
      const tx = runtime.edit();
      writeSeedEnvelopeDoc(tx, owner);
      seedStoredEnvelope(tx, { ...root.getAsNormalizedFullLink(), path: [] }, {
        value: { rooms: [] },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [
              {
                path: [],
                origin: "structure",
                observes: "enumerate",
                label: { confidentiality: [own, ...others] },
              },
            ],
          },
        },
      } as never);
      expect((await tx.commit().settled).error).toBeUndefined();

      const piece = {
        input: { getCell: () => Promise.resolve(root) },
        result: { getCell: () => Promise.resolve(root) },
      };
      const pieces = {
        runtime,
        get: () => Promise.resolve(piece),
        synced: () => Promise.resolve(),
      };
      signed = 0;
      // The owner's identity, counting what it signs.
      const counting = {
        did: () => signer.did(),
        sign: (payload: Uint8Array) => {
          signed++;
          return signer.sign(payload as never);
        },
      };
      deps = {
        loadPieces: () => Promise.resolve(pieces as never),
        resolvePieceAddress: (_pieces: unknown, token: string) =>
          Promise.resolve(token),
        loadIdentity: () => Promise.resolve(counting as never),
        isStdinTerminal: () => true,
        show: () => {},
      } as never;
    });

    afterEach(async () => {
      await runtime.dispose();
      await storageManager.close();
    });

    it("lists the clauses stored at the path, with their digests, and changes nothing", async () => {
      const before = storedEntries();
      const outcome = await releaseCellConfidentialityByIntent(
        pieceConfig,
        [],
        [],
        {},
        { ...deps, isStdinTerminal: () => false },
      );
      expect(outcome.clauses.map((clause) => clause.digest)).toEqual(
        [own, ...others].map(cfcCanonicalClauseDigest),
      );
      expect(outcome.clauses[1].positions).toEqual([
        { origin: "structure", observes: "enumerate" },
      ]);
      expect(outcome.released).toBeUndefined();
      expect(signed).toBe(0);
      expect(storedEntries()).toEqual(before);
    });

    it("releases the clauses named by digest prefixes once the owner types the word, and records it", async () => {
      const prefixes = others.map((clause) =>
        cfcCanonicalClauseDigest(clause).slice(0, 6)
      );
      const outcome = await releaseCellConfidentialityByIntent(
        pieceConfig,
        [],
        prefixes,
        {},
        { ...deps, readConfirmation: () => Promise.resolve("release") },
      );

      expect(signed).toBe(1);
      expect([...outcome.released!].sort()).toEqual(
        others.map(cfcCanonicalClauseDigest).sort(),
      );
      expect(storedEntries()).toEqual([{
        path: [],
        origin: "structure",
        observes: "enumerate",
        label: { confidentiality: [own] },
      }]);
      const tx = runtime.edit();
      const record = tx.readOrThrow({
        space: owner,
        id: outcome.record! as never,
        scope: "space",
        type: "application/json",
        path: ["value"],
      });
      tx.abort();
      expect(parseOwnerReleaseByIntentRecord(record)?.owner).toBe(owner);
    });

    it("signs and releases nothing when the owner does not type the word", async () => {
      const before = storedEntries();
      await expect(
        releaseCellConfidentialityByIntent(
          pieceConfig,
          [],
          [cfcCanonicalClauseDigest(others[0])],
          {},
          { ...deps, readConfirmation: () => Promise.resolve("yes") },
        ),
      ).rejects.toThrow("Not confirmed; nothing was signed or released.");
      expect(signed).toBe(0);
      expect(storedEntries()).toEqual(before);
    });

    it("signs nothing for an ambiguous or unknown digest", async () => {
      await expect(
        releaseCellConfidentialityByIntent(pieceConfig, [], ["zzzzzzzz"], {}, {
          ...deps,
          readConfirmation: () => Promise.resolve("release"),
        }),
      ).rejects.toThrow("beginning `zzzzzzzz`");
      expect(signed).toBe(0);
    });
  });
});
