/** Checks reference history independently of content-addressed target bytes. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import type { Cell } from "../src/cell.ts";
import { normalizeClause } from "../src/cfc/clause.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import type { CfcMetadata } from "../src/cfc/types.ts";
import {
  compiledDocKey,
  getCompileCacheRuntimeVersion,
  loadCompiledClosure,
  loadSourceClosure,
  sourceDocKey,
  verifySourceDocs,
  writeCompiledDocs,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";
import { computeModuleHashes } from "../src/harness/module-identity.ts";
import type { CacheableModule } from "../src/harness/types.ts";
import { createSigilLinkFromParsedLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-cid-reference");
const space = signer.did();
const selection = normalizeClause({
  anyOf: ["private-cid-selection", cfcAtom.space(space)],
});

describe("cfc-cid-reference", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  /** Installs immutable bytes without a CFC envelope. */
  async function installCode(): Promise<Cell<string>> {
    const tx = runtime.edit();
    const id = tx.stageContentAddressedDocument(space, "public module bytes");
    expect((await tx.commit()).error).toBeUndefined();
    return runtime.getCellFromLink({ space, id, path: [] });
  }

  /** Reads the receiving slot's stored reference label. */
  function referenceEntries(cell: Cell<unknown>) {
    const tx = runtime.edit();
    try {
      const metadata = tx.readOrThrow({
        ...cell.getAsNormalizedFullLink(),
        path: ["cfc"],
      }) as CfcMetadata | undefined;
      expect(metadata).toBeDefined();
      return metadata!.labelMap.entries.filter((entry) =>
        entry.origin === "link" && entry.observes === "followRef"
      );
    } finally {
      tx.abort();
    }
  }

  it("retains private CID selection across abort, forwarding, and cold reads", async () => {
    const target = await installCode();
    const install = runtime.edit();
    const selected = runtime.getCell(space, "selected", undefined, install);
    writeSeedEnvelopeDoc(install, space);
    seedStoredEnvelope(install, {
      ...selected.getAsNormalizedFullLink(),
      path: [],
    }, {
      value: target.getAsLink(),
      cfc: {
        version: 3,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{
            path: [],
            origin: "link",
            observes: "followRef",
            referenceAcquisition: "complete",
            label: { confidentiality: [selection] },
          }],
        },
      },
    });
    expect((await install.commit()).error).toBeUndefined();
    const acquire = runtime.edit();
    const held = selected.withTx(acquire).resolveAsCell().withTx(undefined);
    acquire.abort();
    const raw = held.getAsLink();
    const write = runtime.edit();
    const output = runtime.getCell(space, "output", undefined, write);
    output.set(raw);
    expect((await write.commit()).error).toBeUndefined();
    expect(
      referenceEntries(output).flatMap((entry) =>
        entry.label.confidentiality ?? []
      ),
    ).toContainEqual(selection);

    const cold = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
    });
    try {
      const read = cold.edit();
      const received = cold.getCell(space, "output", undefined, read);
      await received.sync();
      expect(received.get()).toBe("public module bytes");
      expect(deriveFlowJoin(read).confidentiality).toContainEqual(selection);
      read.abort();
    } finally {
      await cold.dispose({ closeStorage: false });
    }
  });

  it("records public CID references without consulting target metadata", async () => {
    const target = await installCode();
    const raw = target.getAsLink();
    const write = runtime.edit();
    const output = runtime.getCell(space, "public-output", undefined, write);
    output.set(raw);
    write.prepareCfc();
    expect(
      [...(write.getReadActivities?.() ?? [])].filter((read) =>
        read.id === target.getAsNormalizedFullLink().id &&
        read.path[0] === "cfc"
      ),
    ).toEqual([]);
    expect((await write.commit()).error).toBeUndefined();
    const entries = referenceEntries(output);
    expect(entries.map((entry) => entry.path)).toEqual([[]]);
    expect(entries.flatMap((entry) => entry.label.confidentiality ?? []))
      .toEqual([]);
    const read = runtime.edit();
    const received = output.withTx(read);
    await received.sync();
    expect(received.get()).toBe("public module bytes");
    expect(deriveFlowJoin(read).confidentiality).toEqual([]);
    read.abort();
  });

  it("refuses a bare CID address without trusted acquisition", async () => {
    const target = await installCode();
    const raw = createSigilLinkFromParsedLink(target.getAsNormalizedFullLink());
    const tx = runtime.edit();
    runtime.getCell(space, "unproven-output", undefined, tx).set(raw);
    expect((await tx.commit()).error?.message).toContain(
      "reference acquisition is unresolved",
    );
  });

  it("refuses scope widening when storing a CID reference", async () => {
    const target = await installCode();
    const widened = target.asSchema({ scope: "space" })
      .asSchema({ scope: "session" }).getAsLink();
    const tx = runtime.edit();
    expect(() =>
      runtime.getCell(space, "widened-output", undefined, tx).set(widened)
    ).toThrow("scope cap cannot be widened for storage");
    tx.abort();
  });

  it("loads source and compiled code through complete persisted CID references", async () => {
    await ensureCompilerStack();
    const runtimeVersion = await getCompileCacheRuntimeVersion();
    expect(runtimeVersion).toBeDefined();
    const code = "export const answer = 42;";
    const program = {
      main: "/main.ts",
      files: [{ name: "/main.ts", contents: code }],
    };
    const identity = computeModuleHashes(program).get(program.main)!;
    const modules: CacheableModule[] = [{
      identity,
      filename: program.main,
      source: code,
      js: code,
      imports: [],
    }];
    const write = runtime.edit();
    writeSourceDocs(runtime, space, modules, identity, write);
    writeCompiledDocs(runtime, space, modules, identity, {
      runtimeVersion: runtimeVersion!,
    }, write);
    expect((await write.commit()).error).toBeUndefined();
    for (
      const cause of [
        sourceDocKey(identity),
        compiledDocKey(runtimeVersion!, identity),
      ]
    ) {
      expect(referenceEntries(runtime.getCell(space, cause))).toContainEqual(
        expect.objectContaining({ path: ["code"] }),
      );
    }
    const read = runtime.edit();
    try {
      const sources = await loadSourceClosure(runtime, space, identity, read);
      expect(sources?.get(identity)?.code).toBe(code);
      expect(verifySourceDocs(identity, sources!).ok).toBe(true);
      const compiled = await loadCompiledClosure(runtime, space, identity, {
        runtimeVersion: runtimeVersion!,
      }, read);
      expect(compiled.get(identity)?.code).toBe(code);
    } finally {
      read.abort();
    }
  });
});
