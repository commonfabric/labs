import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";

import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import type { CfcFlowLabelsMode } from "../src/cfc/types.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("runner-cfc-list-link-labels");
const space: MemorySpace = signer.did();

const LABEL = "personal-space";

// A confidential element whose nested secret has a separate content label.
const labeledSchema: JSONSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    secret: { type: "string", ifc: { confidentiality: ["secret-note"] } },
  },
  ifc: { confidentiality: [LABEL] },
};

// A list that declares a label for every element it holds, rather than
// holding labels its elements' links brought.
const declaredListSchema: JSONSchema = {
  type: "array",
  items: { type: "object", ifc: { confidentiality: [LABEL] } },
};

// A document that declares a label at one field, which a link then fills.
const declaredFieldSchema: JSONSchema = {
  type: "object",
  properties: { x: { type: "object", ifc: { confidentiality: [LABEL] } } },
};

const createRuntime = (flow: CfcFlowLabelsMode) => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: flow,
    // The write floor credits the flow meet only where flow labels persist,
    // so a runtime below `persist` keeps it at `observe`, as the presets do.
    ...(flow === "persist" ? {} : { cfcWriteFloor: "observe" as const }),
  });
  return { runtime, storageManager };
};

type Fixture = ReturnType<typeof createRuntime> & {
  /** An element carrying labels, and three that carry none. */
  a: Cell<unknown>;
  b: Cell<unknown>;
  c: Cell<unknown>;
  d: Cell<unknown>;
};

const setUp = async (flow: CfcFlowLabelsMode): Promise<Fixture> => {
  const { runtime, storageManager } = createRuntime(flow);
  const result = await commit(runtime, (tx) => {
    runtime.getCell(space, "a", labeledSchema, tx).set({
      title: "A",
      secret: "s",
    });
    for (const name of ["b", "c", "d"]) {
      runtime.getCell(space, name, undefined, tx).set({ title: name });
    }
  });
  expect(result.error).toBeUndefined();
  return {
    runtime,
    storageManager,
    a: runtime.getCell(space, "a"),
    b: runtime.getCell(space, "b"),
    c: runtime.getCell(space, "c"),
    d: runtime.getCell(space, "d"),
  };
};

const tearDown = async ({ runtime, storageManager }: Fixture) => {
  await runtime.dispose();
  await storageManager.close();
};

const commit = async (
  runtime: Runtime,
  write: (tx: IExtendedStorageTransaction) => void,
) => {
  const tx = runtime.edit();
  tx.setCfcEnforcementMode("enforce-explicit");
  write(tx);
  tx.prepareCfc();
  return await tx.commit();
};

/** Commits `elements` as the whole value of the list document `name`. */
const setList = (
  runtime: Runtime,
  elements: readonly Cell<unknown>[],
  name = "list",
  schema?: JSONSchema,
) =>
  commit(runtime, (tx) => {
    runtime.getCell(space, name, schema, tx).set([...elements]);
  });

/**
 * One stored label, as a string that compares every clause it holds, its
 * object keys sorted so that two spellings of one atom compare equal.
 */
const labelString = (
  path: readonly string[],
  confidentiality: readonly unknown[] = [],
  integrity: readonly unknown[] = [],
): string =>
  `/${path.join("/")}: ${
    JSON.stringify(
      { confidentiality, integrity },
      (_key, value) =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1),
          )
          : value,
    )
  }`;

/**
 * The stored label entries of document `name` that hold a clause, confidentiality
 * and integrity alike, sorted, so a comparison names each position's labels.
 */
const storedLabels = (runtime: Runtime, name = "list"): string[] => {
  const tx = runtime.edit();
  try {
    const metadata = readStoredCfcMetadata(tx, {
      space,
      id: idOf(runtime, name),
    });
    return (metadata?.labelMap.entries ?? [])
      .filter((entry) =>
        (entry.label.confidentiality?.length ?? 0) > 0 ||
        (entry.label.integrity?.length ?? 0) > 0
      )
      .map((entry) =>
        labelString(
          entry.path,
          entry.label.confidentiality,
          entry.label.integrity,
        )
      )
      .sort();
  } finally {
    tx.abort();
  }
};

const idOf = (runtime: Runtime, name: string): string =>
  runtime.getCell(space, name).getAsNormalizedFullLink().id;

/**
 * The labels document `name` stores where the labeled element `a` is linked
 * at `path`: `a`'s label and the reference from that position to `a` at the
 * slot, and `a`'s `secret` label below it.
 */
const labelsOfAAt = (
  runtime: Runtime,
  path: readonly string[],
  name = "list",
): string[] =>
  [
    labelString(path, [LABEL], [{
      type: CFC_ATOM_TYPE.LinkReference,
      source: { space, id: idOf(runtime, "a"), path: [] },
      target: { space, id: idOf(runtime, name), path },
    }]),
    labelString([...path, "secret"], ["secret-note"]),
  ].sort();

describe("cfc-list-link-labels", () => {
  describe("with flow labels persist", () => {
    it("retains independent reference proofs through list edits", async () => {
      const fixture = await setUp("persist");
      try {
        const { runtime, a, b, c, d } = fixture;
        for (
          const elements of [
            [a, b],
            [b, a],
            [a, b],
            [b],
            [b, b],
            [b, c, a],
            [c, d],
            [a, b, c],
            [b, c, a],
            [b, a, c],
            [a],
            [],
          ]
        ) {
          expect((await setList(runtime, elements)).error).toBeUndefined();
          const tx = runtime.edit();
          try {
            const metadata = readStoredCfcMetadata(tx, {
              space,
              id: idOf(runtime, "list"),
            });
            expect(metadata?.version).toBe(3);
            const references = metadata!.labelMap.entries.filter((entry) =>
              entry.origin === "link"
            );
            expect(references).toHaveLength(elements.length);
            for (let index = 0; index < elements.length; index++) {
              const path = [String(index)];
              const entry = references.find((entry) =>
                entry.path.length === 1 && entry.path[0] === path[0]
              );
              expect(entry).toMatchObject({
                path,
                observes: "followRef",
                referenceAcquisition: "complete",
              });
              expect(entry!.label.confidentiality ?? []).toEqual([]);
              expect(entry!.label.integrity).toEqual([{
                type: CFC_ATOM_TYPE.LinkReference,
                source: {
                  space,
                  id: elements[index].getAsNormalizedFullLink().id,
                  path: [],
                },
                target: { space, id: idOf(runtime, "list"), path },
              }]);
              expect(
                runtime.getCell(space, "list", undefined, tx).key(index)
                  .resolveAsCell().getAsNormalizedFullLink().id,
              )
                .toBe(elements[index].getAsNormalizedFullLink().id);
            }
            expect(
              metadata!.labelMap.entries.flatMap((entry) =>
                entry.label.confidentiality ?? []
              ),
            ).toEqual([]);
          } finally {
            tx.abort();
          }
        }
      } finally {
        await tearDown(fixture);
      }
    });

    it("accepts public references under a confidential destination declaration", async () => {
      const fixture = await setUp("persist");
      try {
        const { runtime, a, b } = fixture;
        expect(
          (await setList(runtime, [a], "declared", declaredListSchema)).error,
        )
          .toBeUndefined();
        expect(
          (await setList(runtime, [b, a], "declared", declaredListSchema))
            .error,
        )
          .toBeUndefined();
        expect(
          (await commit(runtime, (tx) => {
            runtime.getCell(space, "declared-holder", declaredFieldSchema, tx)
              .set({ x: a });
          })).error,
        ).toBeUndefined();
        expect(
          (await commit(runtime, (tx) => {
            runtime.getCell(space, "declared-holder", undefined, tx).key("x")
              .set(b);
          })).error,
        ).toBeUndefined();
      } finally {
        await tearDown(fixture);
      }
    });

    it("preserves reference acquisition through raw and sibling metadata writes", async () => {
      const fixture = await setUp("persist");
      try {
        const { runtime, a, b, c } = fixture;
        expect((await setList(runtime, [a, b])).error).toBeUndefined();
        expect(
          (await commit(runtime, (tx) => {
            runtime.getCell(space, "list", undefined, tx).setRaw([
              a.getAsLink(),
              c.getAsLink(),
            ]);
          })).error,
        ).toBeUndefined();
        const source = runtime.getCell(space, "list").key(0).resolveAsCell();
        expect(source.getAsNormalizedFullLink().id).toBe(
          a.getAsNormalizedFullLink().id,
        );
        const holder = (n: number) =>
          commit(runtime, (tx) => {
            runtime.getCell(space, "holder", undefined, tx).set({
              x: a,
              schema: b,
              "*": n,
            });
          });
        expect((await holder(1)).error).toBeUndefined();
        const before = storedLabels(runtime, "holder");
        expect((await holder(2)).error).toBeUndefined();
        expect(
          (await commit(runtime, (tx) => {
            runtime.getCell(space, "holder", undefined, tx).setMetaRaw(
              "schema",
              { type: "object" },
              rawMetaWriteAuthorization,
            );
          })).error,
        ).toBeUndefined();
        expect(storedLabels(runtime, "holder")).toEqual(before);
        for (const [field, target] of [["x", a], ["schema", b]] as const) {
          expect(
            runtime.getCell(space, "holder").key(field).resolveAsCell()
              .getAsNormalizedFullLink().id,
          ).toBe(target.getAsNormalizedFullLink().id);
        }
      } finally {
        await tearDown(fixture);
      }
    });
    it("refuses a fabricated reference write policy input", async () => {
      const fixture = await setUp("persist");
      try {
        const { runtime, a, b } = fixture;
        expect((await setList(runtime, [a, b])).error).toBeUndefined();
        const before = storedLabels(runtime);
        const refused = await commit(runtime, (tx) => {
          tx.recordCfcWritePolicyInput({
            kind: "link-write",
            target: {
              ...runtime.getCell(space, "list").getAsNormalizedFullLink(),
              path: ["0"],
            },
            source: b.getAsNormalizedFullLink(),
          });
        });
        expect(refused.error?.message).toContain(
          "reference acquisition is unresolved",
        );
        expect(storedLabels(runtime)).toEqual(before);
      } finally {
        await tearDown(fixture);
      }
    });
  });
  // Recursive target-label copying is retained only in the legacy flow mode.
  for (const flow of ["off"] as const) {
    describe(`with flow labels ${flow}`, () => {
      it("stores the labels of a linked element at its position", async () => {
        const fixture = await setUp(flow);
        try {
          const { runtime, a, b } = fixture;
          expect((await setList(runtime, [a, b])).error).toBeUndefined();
          expect(storedLabels(runtime)).toEqual(labelsOfAAt(runtime, ["0"]));
        } finally {
          await tearDown(fixture);
        }
      });

      it("moves an unlabeled element into the position a labeled one left", async () => {
        const fixture = await setUp(flow);
        try {
          const { runtime, a, b } = fixture;
          expect((await setList(runtime, [a, b])).error).toBeUndefined();

          expect((await setList(runtime, [b, a])).error).toBeUndefined();
          expect(storedLabels(runtime)).toEqual(labelsOfAAt(runtime, ["1"]));

          // And back again.
          expect((await setList(runtime, [a, b])).error).toBeUndefined();
          expect(storedLabels(runtime)).toEqual(labelsOfAAt(runtime, ["0"]));
        } finally {
          await tearDown(fixture);
        }
      });

      it("removes a labeled element ahead of an unlabeled one", async () => {
        const fixture = await setUp(flow);
        try {
          const { runtime, a, b } = fixture;
          expect((await setList(runtime, [a, b])).error).toBeUndefined();

          expect((await setList(runtime, [b])).error).toBeUndefined();
          expect(storedLabels(runtime)).toEqual([]);
        } finally {
          await tearDown(fixture);
        }
      });

      it("drops the labels of a trailing position the list no longer has", async () => {
        const fixture = await setUp(flow);
        try {
          const { runtime, a, b } = fixture;
          expect((await setList(runtime, [b, a])).error).toBeUndefined();

          expect((await setList(runtime, [b])).error).toBeUndefined();
          expect(storedLabels(runtime)).toEqual([]);

          // An unlabeled element appended into that position carries nothing
          // of the element that left it.
          expect((await setList(runtime, [b, b])).error).toBeUndefined();
          expect(storedLabels(runtime)).toEqual([]);
        } finally {
          await tearDown(fixture);
        }
      });

      it("inserts an unlabeled element where a labeled one stood, shifting it", async () => {
        const fixture = await setUp(flow);
        try {
          const { runtime, a, b, c } = fixture;
          expect((await setList(runtime, [b, a])).error).toBeUndefined();

          expect((await setList(runtime, [b, c, a])).error).toBeUndefined();
          expect(storedLabels(runtime)).toEqual(labelsOfAAt(runtime, ["2"]));
        } finally {
          await tearDown(fixture);
        }
      });

      it("replaces the whole list with unlabeled elements", async () => {
        const fixture = await setUp(flow);
        try {
          const { runtime, a, b, c, d } = fixture;
          expect((await setList(runtime, [a, b])).error).toBeUndefined();

          expect((await setList(runtime, [c, d])).error).toBeUndefined();
          expect(storedLabels(runtime)).toEqual([]);
        } finally {
          await tearDown(fixture);
        }
      });

      it("keeps a labeled element's labels at each position it moves to", async () => {
        const fixture = await setUp(flow);
        try {
          const { runtime, a, b, c } = fixture;
          expect((await setList(runtime, [a, b, c])).error).toBeUndefined();

          expect((await setList(runtime, [b, c, a])).error).toBeUndefined();
          expect(storedLabels(runtime)).toEqual(labelsOfAAt(runtime, ["2"]));

          expect((await setList(runtime, [b, a, c])).error).toBeUndefined();
          expect(storedLabels(runtime)).toEqual(labelsOfAAt(runtime, ["1"]));
        } finally {
          await tearDown(fixture);
        }
      });

      it("keeps a labeled element's labels while the list around it changes", async () => {
        const fixture = await setUp(flow);
        try {
          const { runtime, a, b, c } = fixture;
          for (const elements of [[a, b], [a, b, c], [a], [a, b]]) {
            expect((await setList(runtime, elements)).error).toBeUndefined();
            expect(storedLabels(runtime)).toEqual(labelsOfAAt(runtime, ["0"]));
          }
        } finally {
          await tearDown(fixture);
        }
      });

      it("keeps a pointer's labels when a raw write rewrites the list around it", async () => {
        // A raw write stores links without recording link writes, so nothing
        // re-mints the labels of a pointer it leaves where it was.
        const fixture = await setUp(flow);
        try {
          const { runtime, a, b, c } = fixture;
          expect((await setList(runtime, [a, b])).error).toBeUndefined();

          const written = await commit(runtime, (tx) => {
            runtime.getCell(space, "list", undefined, tx).setRaw([
              a.getAsLink(),
              c.getAsLink(),
            ]);
          });
          expect(written.error).toBeUndefined();
          expect(storedLabels(runtime)).toEqual(labelsOfAAt(runtime, ["0"]));
        } finally {
          await tearDown(fixture);
        }
      });

      it("keeps a sibling pointer's labels when a field named `*` is written", async () => {
        const fixture = await setUp(flow);
        try {
          const { runtime, a } = fixture;
          const holder = (value: number) =>
            commit(runtime, (tx) => {
              runtime.getCell(space, "holder", undefined, tx).set({
                x: a,
                "*": value,
              });
            });
          expect((await holder(1)).error).toBeUndefined();
          const labels = labelsOfAAt(runtime, ["x"], "holder");
          expect(storedLabels(runtime, "holder")).toEqual(labels);

          expect((await holder(2)).error).toBeUndefined();
          expect(storedLabels(runtime, "holder")).toEqual(labels);
        } finally {
          await tearDown(fixture);
        }
      });

      it("still refuses an unlabeled element at a position the document declares a label for", async () => {
        // The declared entry sits at the slot itself, where the link-origin
        // entries a link write disregards also sit.
        const fixture = await setUp(flow);
        try {
          const { runtime, a, b } = fixture;
          const declared = await commit(runtime, (tx) => {
            runtime.getCell(space, "declared-holder", declaredFieldSchema, tx)
              .set({ x: a });
          });
          expect(declared.error).toBeUndefined();

          const refused = await commit(runtime, (tx) => {
            runtime.getCell(space, "declared-holder", undefined, tx).key("x")
              .set(b);
          });
          expect(refused.error?.message).toContain(
            "missing link source metadata",
          );
        } finally {
          await tearDown(fixture);
        }
      });

      it("keeps a payload field's labels when the meta field of that name is written", async () => {
        // A meta field and a payload field of the same name share a logical
        // path, and the meta write replaces nothing in the payload.
        const fixture = await setUp(flow);
        try {
          const { runtime, a } = fixture;
          const written = await commit(runtime, (tx) => {
            runtime.getCell(space, "holder", undefined, tx).set({ schema: a });
          });
          expect(written.error).toBeUndefined();
          const labels = storedLabels(runtime, "holder");
          expect(labels).toEqual(labelsOfAAt(runtime, ["schema"], "holder"));

          const metaWritten = await commit(runtime, (tx) => {
            runtime.getCell(space, "holder", undefined, tx).setMetaRaw(
              "schema",
              { type: "object" },
              rawMetaWriteAuthorization,
            );
          });
          expect(metaWritten.error).toBeUndefined();
          expect(storedLabels(runtime, "holder")).toEqual(labels);
        } finally {
          await tearDown(fixture);
        }
      });

      it("still refuses an unlabeled element in a list that declares a label", async () => {
        const fixture = await setUp(flow);
        try {
          const { runtime, a, b } = fixture;
          expect(
            (await setList(runtime, [a], "declared", declaredListSchema))
              .error,
          ).toBeUndefined();

          const refused = await setList(
            runtime,
            [b, a],
            "declared",
            declaredListSchema,
          );
          expect(refused.error?.message).toContain(
            "missing link source metadata",
          );
        } finally {
          await tearDown(fixture);
        }
      });

      it("still refuses a link-write input naming an unlabeled source at a labeled position", async () => {
        // The input claims the position now links an unlabeled element, and
        // nothing was written there: the position's labels stay as they are
        // only if the claim is refused.
        const fixture = await setUp(flow);
        try {
          const { runtime, a, b } = fixture;
          expect((await setList(runtime, [a, b])).error).toBeUndefined();

          const list = runtime.getCell(space, "list")
            .getAsNormalizedFullLink();
          const source = b.getAsNormalizedFullLink();
          const refused = await commit(runtime, (tx) => {
            tx.recordCfcWritePolicyInput({
              kind: "link-write",
              target: {
                space,
                id: list.id,
                scope: list.scope,
                path: ["0"],
              },
              source: {
                space,
                id: source.id,
                scope: source.scope,
                path: [],
              },
            });
          });
          expect(refused.error?.message).toContain(
            "missing link source metadata",
          );
          expect(storedLabels(runtime)).toEqual(labelsOfAAt(runtime, ["0"]));
        } finally {
          await tearDown(fixture);
        }
      });
    });
  }
});
