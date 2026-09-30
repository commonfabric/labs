import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isAuthorizationRead } from "../src/storage/reactivity-log.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-linked-content-floor");
const foreignSpace = (await Identity.fromPassphrase("cfc-content-foreign"))
  .did();
const APPROVED = "approved-content";
const floorSchema = {
  type: "object",
  properties: {
    selected: { type: "string", ifc: { requiredIntegrity: [APPROVED] } },
  },
} as const satisfies JSONSchema;

describe("prepare", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcWriteFloor: "enforce",
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  const seed = async (
    name: string,
    value: FabricValue,
    entries: LabelMapEntry[] = [],
    space: MemorySpace = signer.did(),
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, name, undefined, tx);
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, {
      ...cell.getAsNormalizedFullLink(),
      path: [],
    }, {
      value,
      cfc: {
        version: 3,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit()).error).toBeUndefined();
    return cell.withTx(undefined);
  };

  it("checks the terminal content label across multiple references", async () => {
    const terminal = await seed("terminal", { text: "approved" }, [{
      path: ["text"],
      label: { integrity: [APPROVED] },
    }]);
    const middle = await seed("middle", {
      next: terminal.key("text").getAsLink(),
    });
    const tx = runtime.edit();
    runtime.getCell(signer.did(), "sink", floorSchema, tx).set({
      selected: middle.key("next") as unknown as string,
    });
    tx.prepareCfc();
    expect((await tx.commit()).error).toBeUndefined();
  });

  it("withholds a protected floor verdict in both integrity worlds", async () => {
    const outcomes: (string | undefined)[] = [];
    for (const approved of [false, true]) {
      const source = await seed("protected-floor-source", "same", [{
        path: [],
        origin: "derived",
        observes: "value",
        label: {
          confidentiality: ["private-review"],
          integrity: approved ? [APPROVED] : [],
        },
      }]);
      const reference = source.getAsLink();
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      runtime.getCell(signer.did(), "protected-floor-sink", floorSchema, tx)
        .set({ selected: reference as unknown as string });
      tx.prepareCfc();
      outcomes.push((await tx.commit()).error?.message);
    }
    expect(outcomes[0]).toBeDefined();
    expect(outcomes[1]).toBe(outcomes[0]);
  });

  it("withholds a direct Cell floor verdict in both integrity worlds", async () => {
    const outcomes: (string | undefined)[] = [];
    for (const approved of [false, true]) {
      const source = await seed("protected-cell-source", "same", [{
        path: [],
        origin: "derived",
        observes: "value",
        label: {
          confidentiality: ["private-review"],
          integrity: approved ? [APPROVED] : [],
        },
      }]);
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      runtime.getCell(signer.did(), "protected-cell-sink", floorSchema, tx)
        .set({ selected: source.withTx(tx) as unknown as string });
      expect(deriveFlowJoin(tx).confidentiality).toEqual([]);
      tx.prepareCfc();
      outcomes.push((await tx.commit()).error?.message);
    }
    expect(outcomes[0]).toBeDefined();
    expect(outcomes[1]).toBe(outcomes[0]);
  });

  it("checks a public direct Cell against its content floor", async () => {
    for (const approved of [false, true]) {
      const source = await seed("public-cell-source", "same", [{
        path: [],
        origin: "derived",
        observes: "value",
        label: { integrity: approved ? [APPROVED] : [] },
      }]);
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      runtime.getCell(signer.did(), "public-cell-sink", floorSchema, tx)
        .set({ selected: source.withTx(tx) as unknown as string });
      expect(deriveFlowJoin(tx).confidentiality).toEqual([]);
      tx.prepareCfc();
      expect((await tx.commit()).error === undefined).toBe(approved);
    }
  });

  const optionalListPredicate = {
    type: "object",
    properties: {
      selected: {
        type: "object",
        properties: {
          list: { type: "array", ifc: { maxConfidentiality: [] } },
        },
      },
    },
  } as const satisfies JSONSchema;

  it("accepts a known absent optional descendant in an available linked document", async () => {
    const source = await seed("absent-optional-source", {});
    const tx = runtime.edit();
    runtime.getCell(
      signer.did(),
      "absent-optional-sink",
      optionalListPredicate,
      tx,
    )
      .set({ selected: source.key("rooms") });
    tx.prepareCfc();
    expect((await tx.commit()).error).toBeUndefined();
  });

  const seedEmptyRoot = async (entries: LabelMapEntry[] = []) => {
    const tx = runtime.edit();
    const source = runtime.getCell(
      signer.did(),
      "empty-value-root",
      undefined,
      tx,
    );
    writeSeedEnvelopeDoc(tx, signer.did());
    seedStoredEnvelope(tx, { ...source.getAsNormalizedFullLink(), path: [] }, {
      cfc: {
        version: 3,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit()).error).toBeUndefined();
    return source.withTx(undefined);
  };

  it("accepts an optional descendant of a loaded envelope without a value root", async () => {
    const source = await seedEmptyRoot();
    const tx = runtime.edit();
    runtime.getCell(signer.did(), "empty-root-sink", optionalListPredicate, tx)
      .set({ selected: source.withTx(tx) });
    tx.prepareCfc();
    expect((await tx.commit()).error).toBeUndefined();
  });

  it("binds an absent value root to the source revision", async () => {
    const source = await seedEmptyRoot();
    const tx = runtime.edit();
    runtime.getCell(signer.did(), "empty-root-sink", optionalListPredicate, tx)
      .set({ selected: source.withTx(tx) });
    tx.prepareCfc();
    expect(tx.getCfcState().prepare.status).toBe("prepared");
    const update = runtime.edit();
    source.withTx(update).set({ list: [] });
    expect((await update.commit()).error).toBeUndefined();
    expect((await tx.commit()).error).toBeDefined();
  });

  it("protects an absent value root's confidentiality", async () => {
    const source = await seedEmptyRoot([{
      path: [],
      observes: "shape",
      origin: "structure",
      label: { confidentiality: ["private-review"] },
    }]);
    const tx = runtime.edit();
    runtime.getCell(signer.did(), "empty-root-sink", optionalListPredicate, tx)
      .set({ selected: source.withTx(tx) });
    tx.prepareCfc();
    expect((await tx.commit()).error?.message).toContain(
      "linked content evidence is unavailable",
    );
  });

  it("does not endorse an absent value root from its envelope's integrity", async () => {
    const source = await seedEmptyRoot([{
      path: [],
      label: { integrity: [APPROVED] },
    }]);
    const tx = runtime.edit();
    tx.setCfcEnforcementMode("enforce-strict");
    runtime.getCell(signer.did(), "empty-root-floor", floorSchema, tx)
      .set({ selected: source.withTx(tx) as unknown as string });
    tx.prepareCfc();
    expect((await tx.commit()).error?.message).toContain(
      "linked content evidence is unavailable",
    );
  });

  for (const nested of [false, true]) {
    it(`accepts explicitly stored undefined at a ${nested ? "field" : "value root"} only with content endorsement`, async () => {
      for (const endorsed of [false, true]) {
        const source = await seed(
          `present-undefined-${nested}-${endorsed}`,
          nested ? { field: undefined } : undefined,
          endorsed
            ? [{
              path: nested ? ["field"] : [],
              label: { integrity: [APPROVED] },
            }]
            : [],
        );
        const tx = runtime.edit();
        const subject = nested ? source.key("field") : source;
        runtime.getCell<unknown>(signer.did(), "present-undefined-floor", {
          type: "object",
          properties: {
            selected: {
              type: ["string", "undefined"],
              ifc: { requiredIntegrity: [APPROVED] },
            },
          },
        }, tx).set({ selected: subject.withTx(tx) });
        tx.prepareCfc();
        expect((await tx.commit()).error === undefined).toBe(endorsed);
      }
    });
  }

  it("binds known linked absence to the source revision at commit", async () => {
    const source = await seed("changing-optional-source", {});
    const tx = runtime.edit();
    runtime.getCell(
      signer.did(),
      "changing-optional-sink",
      optionalListPredicate,
      tx,
    )
      .set({ selected: source.key("rooms") });
    tx.prepareCfc();
    expect(tx.getCfcState().prepare.status).toBe("prepared");
    expect(
      [...(tx.getReadActivities?.() ?? [])].some((read) =>
        read.id === source.getAsNormalizedFullLink().id &&
        isAuthorizationRead(read.meta)
      ),
    ).toBe(true);
    const update = runtime.edit();
    source.withTx(update).set({ rooms: { list: ["unapproved"] } });
    expect((await update.commit()).error).toBeUndefined();
    expect((await tx.commit()).error).toBeDefined();
  });

  it("withholds the same verdict for private missing and present optional descendants", async () => {
    const outcomes: (string | undefined)[] = [];
    for (const value of [{}, { rooms: { list: ["unapproved"] } }]) {
      const source = await seed("private-optional-source", value, [{
        path: [],
        label: { confidentiality: ["private-review"] },
      }]);
      const tx = runtime.edit();
      runtime.getCell(
        signer.did(),
        "private-optional-sink",
        optionalListPredicate,
        tx,
      )
        .set({ selected: source.key("rooms") });
      tx.prepareCfc();
      outcomes.push((await tx.commit()).error?.message);
    }
    expect(outcomes[0]).toContain("linked content evidence is unavailable");
    expect(outcomes[1]).toBe(outcomes[0]);
  });

  for (const shapePath of [[], ["rooms"]]) {
    it(`withholds optional presence verdicts protected by shape at /${shapePath.join("/")}`, async () => {
      const outcomes: (string | undefined)[] = [];
      for (const value of [{}, { rooms: { list: [] } }]) {
        const source = await seed("private-optional-shape-source", value, [{
          path: shapePath,
          origin: "structure",
          observes: "shape",
          label: { confidentiality: ["private-review"] },
        }]);
        const tx = runtime.edit();
        runtime.getCell(
          signer.did(),
          "private-optional-shape-sink",
          optionalListPredicate,
          tx,
        )
          .set({ selected: source.key("rooms") });
        tx.prepareCfc();
        outcomes.push((await tx.commit()).error?.message);
      }
      expect(outcomes[0]).toContain("linked content evidence is unavailable");
      expect(outcomes[1]).toBe(outcomes[0]);
    });
  }

  it("refuses unavailable documents when an optional descendant is asserted", async () => {
    const tx = runtime.edit();
    const missing = runtime.getCell(
      signer.did(),
      "unavailable-optional-source",
      undefined,
      tx,
    );
    runtime.getCell(
      signer.did(),
      "unavailable-optional-sink",
      optionalListPredicate,
      tx,
    )
      .set({ selected: missing.key("rooms") });
    tx.prepareCfc();
    expect((await tx.commit()).error?.message).toContain(
      "linked content evidence is unavailable",
    );
  });

  it("does not treat known absence as endorsement evidence", async () => {
    const source = await seed("absent-content-source", {});
    const tx = runtime.edit();
    runtime.getCell(signer.did(), "absent-content-sink", floorSchema, tx)
      .set({ selected: source.key("rooms").key("list") as unknown as string });
    tx.prepareCfc();
    expect((await tx.commit()).error?.message).toContain(
      "linked content evidence is unavailable",
    );
  });

  it("does not consume unrelated sibling content to establish optional absence", async () => {
    const source = await seed("absent-sibling-source", { private: "secret" }, [{
      path: ["private"],
      label: { confidentiality: ["private-review"] },
    }]);
    const tx = runtime.edit();
    runtime.getCell(
      signer.did(),
      "absent-sibling-sink",
      optionalListPredicate,
      tx,
    )
      .set({ selected: source.key("rooms") });
    tx.prepareCfc();
    expect((await tx.commit()).error).toBeUndefined();
  });

  for (const transfer of ["cell", "sigil"] as const) {
    const guardedCases: {
      name: string;
      selected: JSONSchema;
      values: FabricValue[];
    }[] = [{
      name: "union",
      selected: {
        anyOf: [
          { type: "string", ifc: { maxConfidentiality: [] } },
          { type: "number" },
        ],
      },
      values: ["same", 42],
    }, {
      name: "nested and absent",
      selected: {
        type: "object",
        properties: {
          text: { type: "string", ifc: { maxConfidentiality: [] } },
        },
      },
      values: [{ text: "same" }, { text: 42 }, {}],
    }, {
      name: "wildcard and empty",
      selected: {
        type: "array",
        items: { type: "string", ifc: { maxConfidentiality: [] } },
      },
      values: [["same"], [42], []],
    }, {
      name: "writer authorization",
      selected: {
        type: "string",
        ifc: { writeAuthorizedBy: ["trusted-handler"] },
      },
      values: ["same", 42],
    }];
    for (const { name, selected, values } of guardedCases) {
      it(`withholds private ${name} applicability for a ${transfer}`, async () => {
        const outcomes: (string | undefined)[] = [];
        const schema = {
          type: "object",
          properties: { selected },
        } as const satisfies JSONSchema;
        for (const value of values) {
          const source = await seed("protected-case-source", value, [{
            path: [],
            origin: "derived",
            observes: "value",
            label: { confidentiality: ["private-review"] },
          }]);
          const reference = source.getAsLink();
          const tx = runtime.edit();
          tx.setCfcEnforcementMode("enforce-strict");
          runtime.getCell(signer.did(), "protected-case-sink", schema, tx)
            .set({
              selected: transfer === "cell" ? source.withTx(tx) : reference,
            });
          expect(deriveFlowJoin(tx).confidentiality).toEqual([]);
          tx.prepareCfc();
          outcomes.push((await tx.commit()).error?.message);
        }
        expect(outcomes[0]).toBeDefined();
        for (const outcome of outcomes) expect(outcome).toBe(outcomes[0]);
      });
    }

    it(`withholds private type applicability for a ${transfer}`, async () => {
      const outcomes: (string | undefined)[] = [];
      const schema = {
        type: "object",
        properties: {
          selected: { type: "string", ifc: { maxConfidentiality: [] } },
        },
      } as const satisfies JSONSchema;
      for (const value of ["same", 42]) {
        const source = await seed("protected-type-source", value, [{
          path: [],
          origin: "derived",
          observes: "value",
          label: { confidentiality: ["private-review"] },
        }]);
        const reference = source.getAsLink();
        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        runtime.getCell(signer.did(), "protected-type-sink", schema, tx)
          .set({
            selected: (transfer === "cell"
              ? source.withTx(tx)
              : reference) as unknown as string,
          });
        expect(deriveFlowJoin(tx).confidentiality).toEqual([]);
        tx.prepareCfc();
        outcomes.push((await tx.commit()).error?.message);
      }
      expect(outcomes[0]).toBeDefined();
      expect(outcomes[1]).toBe(outcomes[0]);
    });

    it(`preserves public type projection for a ${transfer}`, async () => {
      const schema = {
        type: "object",
        properties: {
          selected: { type: "string", ifc: { maxConfidentiality: [] } },
        },
      } as const satisfies JSONSchema;
      for (const value of ["same", 42]) {
        const source = await seed(`public-type-${value}`, value);
        const reference = source.getAsLink();
        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        runtime.getCell(signer.did(), `public-type-sink-${value}`, schema, tx)
          .set({
            selected: (transfer === "cell"
              ? source.withTx(tx)
              : reference) as unknown as string,
          });
        tx.prepareCfc();
        expect((await tx.commit()).error).toBeUndefined();
      }
    });

    it(`checks known confidential type applicability for a ${transfer}`, async () => {
      const schema = {
        type: "object",
        ifc: { confidentiality: ["private-review"] },
        properties: {
          selected: {
            type: "string",
            ifc: { maxConfidentiality: ["private-review"] },
          },
        },
      } as const satisfies JSONSchema;
      for (const value of ["same", 42]) {
        const source = await seed(`known-type-${value}`, value, [{
          path: [],
          origin: "derived",
          observes: "value",
          label: { confidentiality: ["private-review"] },
        }]);
        const sink = runtime.getCell(
          signer.did(),
          `known-type-sink-${value}`,
          schema,
        );
        const declareTx = runtime.edit();
        sink.withTx(declareTx).set({ selected: "initial" });
        declareTx.prepareCfc();
        expect((await declareTx.commit()).error).toBeUndefined();
        const reference = source.getAsLink();
        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-strict");
        expect(tx.readValueOrThrow(source.getAsNormalizedFullLink())).toBe(
          value,
        );
        sink.withTx(tx).set({
          selected: (transfer === "cell"
            ? source.withTx(tx)
            : reference) as unknown as string,
        });
        expect(deriveFlowJoin(tx).confidentiality).toContain("private-review");
        tx.prepareCfc();
        expect((await tx.commit()).error).toBeUndefined();
      }
    });
  }

  it("accepts a protected floor when the attempt already carries its confidentiality", async () => {
    const source = await seed("consumed-protected-source", "approved", [{
      path: [],
      origin: "derived",
      observes: "value",
      label: {
        confidentiality: ["private-review"],
        integrity: [APPROVED],
      },
    }]);
    const schema = {
      ...floorSchema,
      ifc: { confidentiality: ["private-review"] },
    } as const satisfies JSONSchema;
    const tx = runtime.edit();
    expect(tx.readValueOrThrow(source.getAsNormalizedFullLink())).toBe(
      "approved",
    );
    expect(deriveFlowJoin(tx).confidentiality).toContain("private-review");
    runtime.getCell(signer.did(), "consumed-protected-sink", schema, tx)
      .set({ selected: source.withTx(tx) as unknown as string });
    tx.prepareCfc();
    expect((await tx.commit()).error).toBeUndefined();
  });

  it("withholds a protected copy verdict in both content worlds", async () => {
    const outcomes: (string | undefined)[] = [];
    for (const matches of [false, true]) {
      const source = await seed("protected-copy-source", { text: "one" }, [{
        path: [],
        origin: "derived",
        observes: "value",
        label: { confidentiality: ["private-review"] },
      }]);
      const destination = await seed("protected-copy-destination", {
        text: matches ? "one" : "two",
      });
      const schema = {
        type: "object",
        properties: {
          input: { type: "object" },
          output: {
            type: "object",
            properties: {
              text: {
                type: "string",
                ifc: { exactCopyOf: ["input", "text"] },
              },
            },
          },
        },
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      runtime.getCell(signer.did(), "protected-copy-sink", schema, tx).set({
        input: source as unknown as { text: string },
        output: destination as unknown as { text: string },
      });
      tx.prepareCfc();
      outcomes.push((await tx.commit()).error?.message);
    }
    expect(outcomes[0]).toBeDefined();
    expect(outcomes[1]).toBe(outcomes[0]);
  });

  it("withholds protected metadata predicates independently of content labels", async () => {
    const outcomes: (string | undefined)[] = [];
    for (const approved of [false, true]) {
      const source = await seed("metadata-floor-source", "same", [{
        path: [],
        label: { integrity: approved ? [APPROVED] : [] },
      }, {
        path: ["cfc", "labels", "value"],
        origin: "label-metadata",
        observes: "labelMetadata",
        label: { confidentiality: ["private-review"] },
      }]);
      const tx = runtime.edit();
      runtime.getCell(signer.did(), "metadata-floor-sink", floorSchema, tx)
        .set({ selected: source as unknown as string });
      tx.prepareCfc();
      outcomes.push((await tx.commit()).error?.message);
    }
    expect(outcomes[0]).toBeDefined();
    expect(outcomes[1]).toBe(outcomes[0]);
  });

  it("uses one refusal for protected successful, missing, and cyclic traversals", async () => {
    const terminal = await seed("protected-hop-terminal", "approved", [{
      path: [],
      label: { integrity: [APPROVED] },
    }]);
    const targets = [
      terminal,
      runtime.getCell(signer.did(), "protected-hop-missing"),
      runtime.getCell(signer.did(), "protected-hop"),
    ];
    const outcomes: (string | undefined)[] = [];
    for (const target of targets) {
      const source = await seed("protected-hop", target.getAsLink(), [{
        path: [],
        origin: "link",
        observes: "followRef",
        referenceAcquisition: "complete",
        label: { confidentiality: ["private-review"] },
      }]);
      const reference = source.getAsLink();
      const tx = runtime.edit();
      runtime.getCell(signer.did(), "protected-hop-sink", floorSchema, tx)
        .set({ selected: reference as unknown as string });
      tx.prepareCfc();
      outcomes.push((await tx.commit()).error?.message);
    }
    expect(outcomes[0]).toBeDefined();
    expect(outcomes[1]).toBe(outcomes[0]);
    expect(outcomes[2]).toBe(outcomes[0]);
  });

  it("withholds the size of a protected wildcard target", async () => {
    const outcomes: (string | undefined)[] = [];
    for (const values of [[], ["approved"]]) {
      const source = await seed("protected-array", values, [{
        path: [],
        origin: "derived",
        observes: "shape",
        label: { confidentiality: ["private-review"] },
      }]);
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "string",
              ifc: { requiredIntegrity: [APPROVED] },
            },
          },
        },
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      runtime.getCell(signer.did(), "protected-array-sink", schema, tx)
        .set({ items: source as unknown as string[] });
      tx.prepareCfc();
      outcomes.push((await tx.commit()).error?.message);
    }
    expect(outcomes[0]).toBeDefined();
    expect(outcomes[1]).toBe(outcomes[0]);
  });

  for (const sourceFirst of [false, true]) {
    it(
      `rejects stale content evidence when the source is written ${
        sourceFirst ? "first" : "last"
      }`,
      async () => {
        const source = await seed("mutable-source", "approved", [{
          path: [],
          origin: "derived",
          observes: "value",
          label: { integrity: [APPROVED] },
        }]);
        const tx = runtime.edit();
        const replace = () => source.withTx(tx).set("unendorsed");
        if (sourceFirst) replace();
        runtime.getCell(signer.did(), "sink", floorSchema, tx).set({
          selected: source as unknown as string,
        });
        if (!sourceFirst) replace();
        tx.prepareCfc();
        expect((await tx.commit()).error?.message).toContain(
          "write floor failed",
        );
      },
    );
  }

  it("uses the current source declaration for replacement contents", async () => {
    const source = await seed("newly-endorsed-source", "old");
    const tx = runtime.edit();
    runtime.getCell(signer.did(), "sink", floorSchema, tx).set({
      selected: source as unknown as string,
    });
    source.withTx(tx).asSchema({
      ifc: { integrity: [APPROVED] },
    }).set("approved replacement");
    tx.prepareCfc();
    expect((await tx.commit()).error).toBeUndefined();
  });

  it("does not credit a relationship endorsement as content evidence", async () => {
    const terminal = await seed("terminal", "unendorsed", [{
      path: [],
      origin: "link",
      observes: "followRef",
      referenceAcquisition: "complete",
      label: { integrity: [APPROVED] },
    }]);
    const tx = runtime.edit();
    runtime.getCell(signer.did(), "sink", floorSchema, tx).set({
      selected: terminal as unknown as string,
    });
    tx.prepareCfc();
    const result = await tx.commit();
    expect(String(result.error?.message)).toContain("write floor failed");
  });

  it("does not credit a mint on the receiving reference as target evidence", async () => {
    const terminal = await seed("terminal", "unendorsed");
    const schema = {
      type: "object",
      properties: {
        selected: {
          type: "string",
          ifc: {
            requiredIntegrity: [APPROVED],
            addIntegrity: [APPROVED],
          },
        },
      },
    } as const satisfies JSONSchema;
    const tx = runtime.edit();
    runtime.getCell(signer.did(), "sink", schema, tx).set({
      selected: terminal as unknown as string,
    });
    tx.prepareCfc();
    const result = await tx.commit();
    expect(String(result.error?.message)).toContain("write floor failed");
  });

  it("does not credit a forged schema on the linked handle", async () => {
    const terminal = await seed("terminal", "unendorsed");
    const forged = terminal.asSchema({
      type: "string",
      ifc: { integrity: [APPROVED] },
    });
    const tx = runtime.edit();
    runtime.getCell(signer.did(), "sink", floorSchema, tx).set({
      selected: forged as unknown as string,
    });
    tx.prepareCfc();
    const result = await tx.commit();
    expect(String(result.error?.message)).toContain("write floor failed");
  });

  for (const approved of [true, false]) {
    it(
      `${approved ? "accepts" : "rejects"} linked wildcard contents with ${
        approved ? "complete" : "incomplete"
      } evidence`,
      async () => {
        const source = await seed("array", [{ name: "one" }, {
          name: "two",
        }], [{
          path: ["0", "name"],
          label: { integrity: [APPROVED] },
        }, {
          path: ["1", "name"],
          label: { integrity: approved ? [APPROVED] : [] },
        }]);
        const schema = {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    ifc: { requiredIntegrity: [APPROVED] },
                  },
                },
              },
            },
          },
        } as const satisfies JSONSchema;
        const tx = runtime.edit();
        runtime.getCell(signer.did(), "sink", schema, tx).set({
          items: source as unknown as { name: string }[],
        });
        tx.prepareCfc();
        const result = await tx.commit();
        if (approved) expect(result.error).toBeUndefined();
        else {
          expect(String(result.error?.message)).toContain(
            "write floor failed at /items/1/name",
          );
        }
      },
    );
  }

  it("rejects unresolved linked contents under a wildcard floor", async () => {
    const source = runtime.getCell(signer.did(), "missing");
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "string",
            ifc: { requiredIntegrity: [APPROVED] },
          },
        },
      },
    } as const satisfies JSONSchema;
    const tx = runtime.edit();
    runtime.getCell(signer.did(), "sink", schema, tx).set({
      items: source as unknown as string[],
    });
    tx.prepareCfc();
    const result = await tx.commit();
    expect(String(result.error?.message)).toContain(
      "linked content evidence is unavailable",
    );
  });

  it("retains traversal and target reads as authorization dependencies", async () => {
    const terminal = await seed("terminal", "approved", [{
      path: [],
      label: { integrity: [APPROVED] },
    }]);
    const middle = await seed("middle", terminal.getAsLink());
    const tx = runtime.edit();
    runtime.getCell(signer.did(), "sink", floorSchema, tx).set({
      selected: middle as unknown as string,
    });
    tx.prepareCfc();
    const reads = [...(tx.getReadActivities?.() ?? [])].filter(
      (read) => isAuthorizationRead(read.meta),
    );
    for (const cell of [middle, terminal]) {
      expect(
        reads.some((read) =>
          read.id === cell.getAsNormalizedFullLink().id &&
          read.path[0] === "value"
        ),
      ).toBe(true);
    }
    tx.abort();
  });

  it("rejects a content floor that depends on another space", async () => {
    const source = await seed("foreign", "approved", [{
      path: [],
      label: { integrity: [APPROVED] },
    }], foreignSpace);
    const tx = runtime.edit();
    runtime.getCell(signer.did(), "sink", floorSchema, tx).set({
      selected: source as unknown as string,
    });
    tx.prepareCfc();
    const result = await tx.commit();
    expect(result.error?.message).toContain("linked content evidence");
  });

  it("rejects a content floor whose chain leaves and returns to its space", async () => {
    const terminal = await seed("terminal", "approved", [{
      path: [],
      label: { integrity: [APPROVED] },
    }]);
    const foreign = await seed(
      "foreign",
      terminal.getAsLink(),
      [],
      foreignSpace,
    );
    const middle = await seed("middle", foreign.getAsLink());
    const tx = runtime.edit();
    runtime.getCell(signer.did(), "sink", floorSchema, tx).set({
      selected: middle as unknown as string,
    });
    tx.prepareCfc();
    const result = await tx.commit();
    expect(result.error?.message).toContain("linked content evidence");
  });

  for (const items of [7, [["unendorsed"], 7]]) {
    it(`refuses a non-array container under a nested wildcard floor (${JSON.stringify(items)})`, async () => {
      const tx = runtime.edit();
      const sink = runtime.getCell(signer.did(), "invalid-wildcard-sink", {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "array",
              items: {
                type: "string",
                ifc: { requiredIntegrity: [APPROVED] },
              },
            },
          },
        },
      }, tx);
      sink.set({ items: items as unknown as string[][] });
      expect((await tx.commit()).error?.message).toContain(
        "wildcard evidence",
      );
    });
  }

  describe("copy assertions", () => {
    for (const referenceOnInput of [false, true]) {
      it(`rejects an exact copy between a reference and its value (referenceOnInput=${referenceOnInput})`, async () => {
        const source = await seed("mixed-copy-source", "same");
        const tx = runtime.edit();
        const sink = runtime.getCell(signer.did(), "mixed-copy-sink", {
          type: "object",
          properties: {
            input: { type: "string" },
            output: { type: "string", ifc: { exactCopyOf: ["input"] } },
          },
        }, tx);
        sink.set({
          input: referenceOnInput ? source as unknown as string : "same",
          output: referenceOnInput ? "same" : source as unknown as string,
        });
        expect((await tx.commit()).error?.message).toContain("exactCopyOf");
      });
    }

    it("refuses to certify two missing final fields as copied content", async () => {
      const source = await seed("missing-copy-source", {});
      const destination = await seed("missing-copy-destination", {});
      const tx = runtime.edit();
      const schema = {
        type: "object",
        properties: {
          input: { type: "object" },
          output: {
            type: "object",
            properties: {
              text: {
                type: ["string", "undefined"],
                ifc: { exactCopyOf: ["input", "text"] },
              },
            },
          },
        },
      } as const satisfies JSONSchema;
      runtime.getCell(signer.did(), "missing-copy-sink", schema, tx).set({
        input: source as unknown as { text?: string },
        output: destination as unknown as { text?: string },
      });
      tx.prepareCfc();
      expect((await tx.commit()).error?.message).toContain("exactCopyOf");
    });

    it("rejects an exact reference copy that changes overwrite mode", async () => {
      const source = await seed("source", "same");
      const schema = {
        type: "object",
        properties: {
          input: { type: "string" },
          output: {
            type: "string",
            ifc: { exactCopyOf: ["input"] },
          },
        },
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      runtime.getCell(signer.did(), "sink", schema, tx).set({
        input: source.getAsLink() as unknown as string,
        output: source.getAsWriteRedirectLink() as unknown as string,
      });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("exactCopyOf");
    });

    for (const kind of ["exactCopyOf", "projection"] as const) {
      it(`rejects ${kind} content evidence in another space`, async () => {
        const source = await seed(
          "foreign",
          { text: "same" },
          [],
          foreignSpace,
        );
        const destination = await seed("destination", { text: "same" });
        const schema = {
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: { text: { type: "string" } },
            },
            output: {
              type: "object",
              properties: {
                text: {
                  type: "string",
                  ifc: kind === "exactCopyOf"
                    ? { exactCopyOf: ["input", "text"] }
                    : { projection: { from: "/input", path: "/text" } },
                },
              },
            },
          },
        } as const satisfies JSONSchema;
        const tx = runtime.edit();
        runtime.getCell(signer.did(), "sink", schema, tx).set({
          input: source as unknown as { text: string },
          output: destination as unknown as { text: string },
        });
        tx.prepareCfc();
        const result = await tx.commit();
        expect(result.error?.message).toContain(kind);
      });
    }

    for (const kind of ["exactCopyOf", "projection"] as const) {
      for (const matches of [true, false]) {
        it(
          `${matches ? "accepts" : "rejects"} ${kind} for ${
            matches ? "equal" : "different"
          } fields beneath references`,
          async () => {
            const source = await seed("source", { text: "one" });
            const destination = await seed("destination", {
              text: matches ? "one" : "two",
            });
            const schema = {
              type: "object",
              properties: {
                input: {
                  type: "object",
                  properties: { text: { type: "string" } },
                },
                output: {
                  type: "object",
                  properties: {
                    text: {
                      type: "string",
                      ifc: kind === "exactCopyOf"
                        ? { exactCopyOf: ["input", "text"] }
                        : { projection: { from: "/input", path: "/text" } },
                    },
                  },
                },
              },
            } as const satisfies JSONSchema;
            const tx = runtime.edit();
            runtime.getCell(signer.did(), "sink", schema, tx).set({
              input: source as unknown as { text: string },
              output: destination as unknown as { text: string },
            });
            tx.prepareCfc();
            const result = await tx.commit();
            if (matches) expect(result.error).toBeUndefined();
            else expect(result.error?.message).toContain(kind);
          },
        );
      }
    }

    it("rejects an exact copy whose fields are unavailable on both sides", async () => {
      const schema = {
        type: "object",
        properties: {
          input: {
            type: "object",
            properties: { text: { type: "string" } },
          },
          output: {
            type: "object",
            properties: {
              text: {
                type: "string",
                ifc: { exactCopyOf: ["input", "text"] },
              },
            },
          },
        },
      } as const satisfies JSONSchema;
      const tx = runtime.edit();
      runtime.getCell(signer.did(), "sink", schema, tx).set({
        input: runtime.getCell(signer.did(), "missing-input") as unknown as {
          text: string;
        },
        output: runtime.getCell(signer.did(), "missing-output") as unknown as {
          text: string;
        },
      });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("exactCopyOf");
    });

    for (const sameBinding of [true, false]) {
      it(
        `${sameBinding ? "accepts" : "rejects"} an exact reference copy with ${
          sameBinding ? "the same" : "a different"
        } binding`,
        async () => {
          const source = await seed("source", { a: "same", b: "same" });
          const schema = {
            type: "object",
            properties: {
              input: { type: "string" },
              output: {
                type: "string",
                ifc: { exactCopyOf: ["input"] },
              },
            },
          } as const satisfies JSONSchema;
          const tx = runtime.edit();
          runtime.getCell(signer.did(), "sink", schema, tx).set({
            input: source.key("a") as unknown as string,
            output: source.key(sameBinding ? "a" : "b").asSchema({
              type: "string",
              description: "A different reader view of the same reference",
            }) as unknown as string,
          });
          tx.prepareCfc();
          const result = await tx.commit();
          if (sameBinding) expect(result.error).toBeUndefined();
          else expect(result.error?.message).toContain("exactCopyOf");
        },
      );
    }
  });
});
