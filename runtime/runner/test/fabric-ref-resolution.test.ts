import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { parseFabricRef } from "../src/sandbox/fabric-import-specifier.ts";
import { resolveFabricRefToIdentity } from "../src/fabric-ref-resolution.ts";
import { slugIdForSpace } from "../src/slugs.ts";
import { entityIdFrom } from "../src/create-ref.ts";
import type { Cell } from "../src/cell.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

const signer = await Identity.fromPassphrase("fabric ref resolution test");
const space = signer.did();

const ENTRY_A = "Avcny13Rj8q-2ClANy_-k0ikWWQcXx7QTdsiqGfrC1c";

describe("fabric ref resolution", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  function parse(specifier: string) {
    const ref = parseFabricRef(specifier);
    if (ref === undefined) throw new Error(`not a fabric ref: ${specifier}`);
    return ref;
  }

  function pieceCell(label: string): Cell<unknown> {
    return runtime.getCell(
      space,
      { space, random: `piece-${label}` },
    );
  }

  async function writeSlug(slug: string, target: Cell<unknown>): Promise<void> {
    const slugCell = runtime.getCellFromEntityId(
      space,
      entityIdFrom(slugIdForSpace(space, slug)),
    );
    await runtime.editWithRetry((tx) => {
      const slugWithTx = slugCell.withTx(tx);
      slugWithTx.setRawUntyped(
        target.withTx(tx).getAsWriteRedirectLink({ base: slugWithTx }),
      );
    });
  }

  it("returns terminal identities for pattern refs", async () => {
    const result = await resolveFabricRefToIdentity(
      runtime,
      space,
      parse(`cf:pattern:${ENTRY_A}`),
    );

    expect(result).toEqual({
      entryIdentity: ENTRY_A,
      chain: [`pattern:${ENTRY_A}`, `entryIdentity:${ENTRY_A}`],
    });
  });

  it("rejects subpaths before resolving an entry identity", async () => {
    await expect(
      resolveFabricRefToIdentity(
        runtime,
        space,
        parse(`cf:pattern:${ENTRY_A}/schemas`),
      ),
    ).rejects.toThrow(
      `subpaths not yet supported (M4): cf:pattern:${ENTRY_A}/schemas`,
    );
  });

  it("resolves a ref naming its space by DID", async () => {
    const result = await resolveFabricRefToIdentity(
      runtime,
      space,
      parse(`cf:/${space}/pattern:${ENTRY_A}`),
    );

    expect(result).toEqual({
      entryIdentity: ENTRY_A,
      chain: [`pattern:${ENTRY_A}`, `entryIdentity:${ENTRY_A}`],
    });
  });

  it("rejects space names", async () => {
    await expect(
      resolveFabricRefToIdentity(runtime, space, parse("cf:/kitchen/todo")),
    ).rejects.toThrow(
      "space names are currently unsupported; resolve the name to a DID first",
    );
  });

  it("resolves slug to piece patternIdentity metadata", async () => {
    const piece = pieceCell("identity");
    await runtime.editWithRetry((tx) => {
      const pieceWithTx = piece.withTx(tx);
      pieceWithTx.set({ name: "piece" });
      pieceWithTx.setMetaRaw("patternIdentity", {
        identity: ENTRY_A,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    await writeSlug("dep", piece);

    const result = await resolveFabricRefToIdentity(
      runtime,
      space,
      parse("cf:dep"),
    );

    expect(result.entryIdentity).toBe(ENTRY_A);
    expect(result.chain).toEqual([
      "slug:dep",
      `piece:${piece.getAsNormalizedFullLink().id}`,
      `patternIdentity:${ENTRY_A}`,
      `entryIdentity:${ENTRY_A}`,
    ]);
  });

  it("reports slug to plain data cells with the chain", async () => {
    const cell = runtime.getCell(space, { space, random: "plain-data" });
    await runtime.editWithRetry((tx) => {
      cell.withTx(tx).set({ value: 1 });
    });
    await writeSlug("plain", cell);

    await expect(
      resolveFabricRefToIdentity(runtime, space, parse("cf:plain")),
    ).rejects.toThrow(
      `cf:plain does not resolve to a pattern (chain: slug:plain)`,
    );
  });

  it("wraps missing slug errors with the chain", async () => {
    await expect(
      resolveFabricRefToIdentity(runtime, space, parse("cf:missing")),
    ).rejects.toThrow(`Slug "missing" not found. (chain: slug:missing)`);
  });

  it("resolves an of: uri ref, preserving the schemed id in the chain", async () => {
    const piece = pieceCell("uri-target");
    await runtime.editWithRetry((tx) => {
      const pieceWithTx = piece.withTx(tx);
      pieceWithTx.set({ name: "uri-target" });
      pieceWithTx.setMetaRaw("patternIdentity", {
        identity: ENTRY_A,
        symbol: "default",
      }, rawMetaWriteAuthorization);
    });
    const pieceUri = piece.getAsNormalizedFullLink().id; // "of:fid1:<hash>"
    expect(pieceUri.startsWith("of:fid1:")).toBe(true);

    const result = await resolveFabricRefToIdentity(
      runtime,
      space,
      parse(`cf:${pieceUri}`),
    );

    expect(result.entryIdentity).toBe(ENTRY_A);
    // The hop carries the FULL schemed URI exactly once — the scheme is part
    // of the identity (a computed: ref is not its of: sibling), and it must
    // not be double-prefixed into "of:of:fid1:…".
    expect(result.chain).toEqual([
      `uri:${pieceUri}`,
      `piece:${pieceUri}`,
      `patternIdentity:${ENTRY_A}`,
      `entryIdentity:${ENTRY_A}`,
    ]);
  });

  it("reports a piece without a pattern identity with the chain", async () => {
    // A piece cell carrying only a legacy `pattern` link (no `patternIdentity`)
    // is unrecoverable post-retirement (the sanctioned data-wipe outcome).
    const piece = pieceCell("legacy");
    await runtime.editWithRetry((tx) => {
      piece.withTx(tx).set({ name: "legacy" });
    });
    await writeSlug("legacy", piece);

    await expect(
      resolveFabricRefToIdentity(runtime, space, parse("cf:legacy")),
    ).rejects.toThrow("does not resolve to a pattern");
  });
});
