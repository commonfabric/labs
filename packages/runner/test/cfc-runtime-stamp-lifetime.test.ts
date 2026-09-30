import { setCfcImplementationIdentity } from "../src/storage/extended-storage-transaction.ts";
/** Runtime evidence belongs to concrete values and their captured authors. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { CFC_COMPILED_BY_ATOM_PREFIX } from "@commonfabric/api/cfc";

import type { JSONSchema } from "../src/builder/types.ts";
import { cfcLabelViewForCell } from "../src/cfc/label-view.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { ImplementationIdentity } from "../src/cfc/types.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-runtime-stamp-lifetime");
const space = signer.did();
const stamp = { type: "https://commonfabric.org/cfc/atom/LlmDerived" };
const compiler = `${CFC_COMPILED_BY_ATOM_PREFIX}test-compiler`;
const sanitizer = { type: "https://commonfabric.org/cfc/atom/InjectionSafe" };
const builtin = { kind: "builtin", builtinId: "stamp-test" } as const;
const plain = {
  type: "array",
  items: { type: "object", properties: { text: { type: "string" } } },
} as const;
const stringPlain = { type: "array", items: { type: "string" } } as const;
const stringStamped = {
  ...stringPlain,
  items: { type: "string", ifc: { addIntegrity: [stamp] } },
} as const;
const stamped = {
  ...plain,
  items: { ...plain.items, ifc: { addIntegrity: [stamp] } },
} as const;

describe("CFC runtime stamp lifetime", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  const atoms = (name: string, path: readonly string[] = []) => {
    const tx = runtime.edit();
    try {
      const cell = runtime.getCell(space, name, undefined, tx).key(...path);
      return (cfcLabelViewForCell(cell)?.entries ?? []).flatMap((entry) =>
        entry.label.integrity ?? []
      );
    } finally {
      tx.abort();
    }
  };

  const useFlowMode = async (flow: "off" | "persist") => {
    if (runtime.cfcFlowLabels === flow) return;
    await runtime.dispose({ closeStorage: false });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
      cfcFlowLabels: flow,
    });
  };

  for (const flow of ["off", "persist"] as const) {
    for (const builtinFirst of [true, false]) {
      it(`keeps mixed-author appends separate with flow ${flow} and builtin ${builtinFirst ? "first" : "last"}`, async () => {
        await useFlowMode(flow);
        const tx = runtime.edit();
        for (const trusted of [builtinFirst, !builtinFirst]) {
          setCfcImplementationIdentity(tx, trusted ? builtin : undefined);
          runtime.getCell(
            space,
            "mixed",
            trusted ? stringStamped : stringPlain,
            tx,
          ).push(trusted ? "model" : "user");
        }
        expect((await tx.commit()).error).toBeUndefined();
        expect(atoms("mixed", [builtinFirst ? "0" : "1"])).toContainEqual(
          stamp,
        );
        expect(atoms("mixed", [builtinFirst ? "1" : "0"])).not.toContainEqual(
          stamp,
        );
        const read = runtime.edit();
        const metadata = readStoredCfcMetadata(
          read,
          runtime.getCell(space, "mixed", stringPlain, read).resolveAsCell()
            .getAsNormalizedFullLink(),
        );
        const entries = metadata!.labelMap.entries.filter((entry) =>
          entry.label.integrity?.some((atom) =>
            typeof atom === "object" && atom !== null && "type" in atom &&
            atom.type === stamp.type
          )
        );
        expect(
          entries.map((entry) => ({
            path: entry.path,
            origin: entry.origin,
            observes: entry.observes,
          })),
        ).toEqual([
          {
            path: [builtinFirst ? "0" : "1"],
            origin: "derived",
            observes: "value",
          },
        ]);
        read.abort();
      });
    }

    it(`invalidates a same-slot stamp after an unattributed rewrite with flow ${flow}`, async () => {
      await useFlowMode(flow);
      const tx = runtime.edit();
      setCfcImplementationIdentity(tx, builtin);
      runtime.getCell(space, "same-slot", stamped, tx).push({ text: "model" });
      setCfcImplementationIdentity(tx, undefined);
      runtime.getCell(space, "same-slot", plain, tx).key(0).set({
        text: "user",
      });
      expect((await tx.commit()).error).toBeUndefined();
      expect(atoms("same-slot", ["0"])).not.toContainEqual(stamp);
    });

    it(`clears a stored parent stamp after a child overwrite or deletion with flow ${flow}`, async () => {
      await useFlowMode(flow);
      const seed = runtime.edit();
      setCfcImplementationIdentity(seed, builtin);
      runtime.getCell(space, "rewrite", stamped, seed).set([{ text: "first" }, {
        text: "second",
      }, { text: "untouched" }]);
      expect((await seed.commit()).error).toBeUndefined();
      expect(atoms("rewrite", ["0"])).toContainEqual(stamp);
      await useFlowMode(flow);
      const tx = runtime.edit();
      const cell = runtime.getCell(space, "rewrite", plain, tx);
      cell.key(0, "text").set("edited");
      tx.writeValueOrThrow(cell.key(1).getAsNormalizedFullLink(), undefined, {
        delete: true,
      });
      expect((await tx.commit()).error).toBeUndefined();
      expect(atoms("rewrite", ["0"])).not.toContainEqual(stamp);
      expect(atoms("rewrite", ["1"])).not.toContainEqual(stamp);
      expect(atoms("rewrite", ["2"])).toContainEqual(stamp);
    });
  }

  it("does not let a later builtin sibling restore an attestation over a user-edited child", async () => {
    const tx = runtime.edit();
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      ifc: { addIntegrity: [stamp] },
    } as const;
    setCfcImplementationIdentity(tx, builtin);
    const cell = runtime.getCell(space, "subtree", schema, tx);
    cell.set({ a: "model-a", b: "model-b" });
    setCfcImplementationIdentity(tx, undefined);
    tx.writeValueOrThrow(
      { ...cell.getAsNormalizedFullLink(), path: ["a"] },
      "user-a",
    );
    setCfcImplementationIdentity(tx, builtin);
    tx.writeValueOrThrow(
      { ...cell.getAsNormalizedFullLink(), path: ["b"] },
      "model-b2",
    );
    expect((await tx.commit()).error).toBeUndefined();
    expect(atoms("subtree")).not.toContainEqual(stamp);
  });

  it("lets a complete builtin replacement shadow prior user edits and satisfy its evidence floor", async () => {
    const tx = runtime.edit();
    tx.setCfcWriteFloorMode("enforce");
    setCfcImplementationIdentity(tx, builtin);
    const schema = {
      type: "object",
      properties: { text: { type: "string" } },
      ifc: { addIntegrity: [stamp], requiredIntegrity: [stamp] },
    } as const;
    const cell = runtime.getCell(space, "replace-parent", schema, tx);
    cell.set({ text: "model" });
    setCfcImplementationIdentity(tx, undefined);
    tx.writeValueOrThrow(
      { ...cell.getAsNormalizedFullLink(), path: ["text"] },
      "user",
    );
    setCfcImplementationIdentity(tx, builtin);
    tx.writeValueOrThrow(cell.getAsNormalizedFullLink(), {
      text: "checked replacement",
    });
    expect((await tx.commit()).error).toBeUndefined();
    expect(atoms("replace-parent")).toContainEqual(stamp);
  });

  it("refuses a runtime-evidence floor after a plain rewrite replaces the builtin value", async () => {
    const tx = runtime.edit();
    tx.setCfcWriteFloorMode("enforce");
    setCfcImplementationIdentity(tx, builtin);
    const schema = {
      type: "string",
      ifc: { addIntegrity: [stamp], requiredIntegrity: [stamp] },
    } as const;
    const cell = runtime.getCell(space, "floor", schema, tx);
    cell.set("model");
    setCfcImplementationIdentity(tx, undefined);
    tx.writeValueOrThrow(cell.getAsNormalizedFullLink(), "user");
    expect((await tx.commit()).error?.message).toContain("write floor");
  });

  it("accepts successive builtin appends through a runtime-evidence floor", async () => {
    const schema = {
      ...stringStamped,
      items: {
        ...stringStamped.items,
        ifc: { addIntegrity: [stamp], requiredIntegrity: [stamp] },
      },
    } as const;
    for (const value of ["first", "second"]) {
      const tx = runtime.edit();
      tx.setCfcWriteFloorMode("enforce");
      setCfcImplementationIdentity(tx, builtin);
      runtime.getCell(space, "append-floor", schema, tx).push(value);
      expect((await tx.commit()).error).toBeUndefined();
    }
    expect(atoms("append-floor", ["0"])).toContainEqual(stamp);
    expect(atoms("append-floor", ["1"])).toContainEqual(stamp);
  });

  it("preserves untouched inline stamps across a later append and invalidates them on replacement", async () => {
    const seed = runtime.edit();
    setCfcImplementationIdentity(seed, builtin);
    runtime.getCell(space, "inline", stringStamped, seed).set([
      "model-a",
      "model-b",
    ]);
    expect((await seed.commit()).error).toBeUndefined();
    const append = runtime.edit();
    runtime.getCell(space, "inline", stringPlain, append).push("user-c");
    expect((await append.commit()).error).toBeUndefined();
    expect(atoms("inline", ["0"])).toContainEqual(stamp);
    expect(atoms("inline", ["1"])).toContainEqual(stamp);
    expect(atoms("inline", ["2"])).not.toContainEqual(stamp);
    const replace = runtime.edit();
    runtime.getCell(space, "inline", stringPlain, replace).set(["user-a"]);
    expect((await replace.commit()).error).toBeUndefined();
    expect(atoms("inline")).not.toContainEqual(stamp);
  });

  it("preserves ordinary declared policy while clearing runtime atom families on replacement", async () => {
    const schema = {
      type: "string",
      ifc: {
        confidentiality: ["policy-C"],
        integrity: ["policy-I"],
        addIntegrity: [stamp, sanitizer, compiler],
      },
    } as const satisfies JSONSchema;
    const seed = runtime.edit();
    setCfcImplementationIdentity(seed, builtin);
    runtime.getCell(space, "families", schema, seed).set("trusted");
    expect((await seed.commit()).error).toBeUndefined();
    expect(atoms("families")).toContainEqual(stamp);
    expect(atoms("families")).toContainEqual(sanitizer);
    expect(atoms("families")).toContain(compiler);
    const tx = runtime.edit();
    runtime.getCell(space, "families", { type: "string" }, tx).set("user");
    expect((await tx.commit()).error).toBeUndefined();
    expect(atoms("families")).toContain("policy-I");
    expect(atoms("families")).not.toContainEqual(stamp);
    expect(atoms("families")).not.toContainEqual(sanitizer);
    expect(atoms("families")).not.toContain(compiler);
    const read = runtime.edit();
    const view = cfcLabelViewForCell(
      runtime.getCell(space, "families", undefined, read),
    );
    expect(view!.entries.flatMap((entry) => entry.label.confidentiality ?? []))
      .toContain("policy-C");
    read.abort();
  });

  for (const path of [[], ["*"]]) {
    it(`clears a legacy runtime declaration at /${path.join("/")} after a payload edit`, async () => {
      const seed = runtime.edit();
      writeSeedEnvelopeDoc(seed, space);
      const cell = runtime.getCell(space, "legacy", undefined, seed);
      seedStoredEnvelope(
        seed,
        { ...cell.getAsNormalizedFullLink(), path: [] },
        {
          value: { text: "before" },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path,
                origin: "declared",
                label: { integrity: [stamp, "ordinary-policy"] },
              }],
            },
          },
        },
      );
      expect((await seed.commit()).error).toBeUndefined();
      expect(atoms("legacy")).toContainEqual(stamp);
      const tx = runtime.edit();
      runtime.getCell(space, "legacy", { type: "object" }, tx).set({
        text: "after",
      });
      expect((await tx.commit()).error).toBeUndefined();
      expect(atoms("legacy")).not.toContainEqual(stamp);
      expect(atoms("legacy")).toContain("ordinary-policy");
    });
  }

  it("ignores batch deletions of absent paths when recording authorship", async () => {
    const seed = runtime.edit();
    const cell = runtime.getCell(space, "batch-absent-delete");
    cell.withTx(seed).set({ present: "user" });
    expect((await seed.commit()).error).toBeUndefined();
    const tx = runtime.edit();
    const address = cell.getAsNormalizedFullLink();
    setCfcImplementationIdentity(tx, builtin);
    tx.writeValuesOrThrow!([
      {
        address: { ...address, path: ["missing"] },
        value: undefined,
        delete: true,
      },
      { address: { ...address, path: ["other"] }, value: "model" },
    ]);
    expect(
      tx.getCfcValueWriteAuthor({ ...address, path: ["missing"] }),
    )
      .toBeUndefined();
    expect(tx.getCfcValueWriteAuthor({ ...address, path: ["other"] })?.identity)
      .toEqual(builtin);
    tx.abort();
  });

  for (const order of [[undefined, builtin], [builtin, undefined]] as const) {
    it(`captures each batch write before its ${order[0] ? "builtin" : "unattributed"} author changes`, () => {
      const tx = runtime.edit();
      const cell = runtime.getCell(space, "batch", undefined, tx);
      const address = cell.getAsNormalizedFullLink();
      cell.set({ first: "old", second: "old" });
      function* writes() {
        for (const [index, identity] of order.entries()) {
          setCfcImplementationIdentity(
            tx,
            identity as ImplementationIdentity | undefined,
          );
          yield {
            address: { ...address, path: [index ? "second" : "first"] },
            value: "new",
          };
        }
      }
      tx.writeValuesOrThrow!(writes());
      expect(
        tx.getCfcValueWriteAuthor({ ...address, path: ["first"] })?.identity,
      )
        .toEqual(order[0]);
      expect(
        tx.getCfcValueWriteAuthor({ ...address, path: ["second"] })?.identity,
      )
        .toEqual(order[1]);
      tx.abort();
    });
  }

  it("does not restore batch authority over a later reentrant write after a document run flushes", async () => {
    const tx = runtime.edit();
    setCfcImplementationIdentity(tx, builtin);
    const cell = runtime.getCell(space, "reentrant", {
      type: "string",
      ifc: { addIntegrity: [stamp] },
    }, tx);
    cell.set("initial");
    const address = cell.getAsNormalizedFullLink();
    const other = runtime.getCell(space, "reentrant-other", undefined, tx)
      .getAsNormalizedFullLink();
    function* writes() {
      yield { address, value: "model" };
      yield { address: other, value: "flush first document" };
      setCfcImplementationIdentity(tx, undefined);
      tx.writeValueOrThrow(address, "user");
    }
    tx.writeValuesOrThrow!(writes());
    expect(tx.readValueOrThrow(address)).toBe("user");
    expect((await tx.commit()).error).toBeUndefined();
    expect(atoms("reentrant")).not.toContainEqual(stamp);
  });

  it("withholds prior mint authority when a batch throws after a partial rewrite", () => {
    const tx = runtime.edit();
    setCfcImplementationIdentity(tx, builtin);
    const cell = runtime.getCell(space, "partial", undefined, tx);
    cell.set({ text: "model" });
    const address = cell.getAsNormalizedFullLink();
    const other = runtime.getCell(space, "partial-other", undefined, tx)
      .getAsNormalizedFullLink();
    function* writes() {
      setCfcImplementationIdentity(tx, undefined);
      yield { address: { ...address, path: ["text"] }, value: "user" };
      yield { address: other, value: "flush first document" };
      throw new Error("incomplete batch");
    }
    expect(() => tx.writeValuesOrThrow!(writes())).toThrow("incomplete batch");
    expect(tx.readValueOrThrow({ ...address, path: ["text"] })).toBe("user");
    expect(tx.getCfcValueWriteAuthor(address)?.identity).toBeUndefined();
    tx.abort();
  });

  it("keeps builtin evidence on a payload field named value", async () => {
    const schema = {
      type: "object",
      properties: {
        value: { type: "string", ifc: { addIntegrity: [stamp] } },
        sibling: { type: "string" },
      },
    } as const;
    const initialize = runtime.edit();
    runtime.getCell(space, "payload-value", undefined, initialize).set({
      value: "initial",
      sibling: "ordinary",
    });
    expect((await initialize.commit()).error).toBeUndefined();
    const write = runtime.edit();
    setCfcImplementationIdentity(write, builtin);
    runtime.getCell(space, "payload-value", schema, write).key("value").set(
      "trusted",
    );
    expect((await write.commit()).error).toBeUndefined();
    expect(atoms("payload-value", ["value"])).toContainEqual(stamp);
    expect(atoms("payload-value", ["sibling"])).not.toContainEqual(stamp);
    const overwrite = runtime.edit();
    runtime.getCell(space, "payload-value", undefined, overwrite).key("value")
      .set("edited");
    expect((await overwrite.commit()).error).toBeUndefined();
    expect(atoms("payload-value", ["value"])).not.toContainEqual(stamp);
  });
});
