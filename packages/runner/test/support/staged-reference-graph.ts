/** Shared reference graphs for label derivation tests and benchmarks. */
import type { MemorySpace } from "@commonfabric/memory/interface";

import type { JSONSchema } from "../../src/builder/types.ts";
import { recordReferencedArgumentFields } from "../../src/cfc/reference-initialization.ts";
import type { Runtime } from "../../src/runtime.ts";

const objectSchema: JSONSchema = {
  type: "object",
  ifc: { integrity: ["object-proof"] },
};

/** Stores the labeled terminal object reached by every graph path. */
export async function seedReferenceGraphLeaf(
  runtime: Runtime,
  space: MemorySpace,
): Promise<void> {
  const tx = runtime.edit();
  runtime.getCell(space, "reference-graph-leaf", {
    type: "object",
    ifc: { confidentiality: ["secret"], integrity: ["leaf-proof"] },
  }, tx).set({ value: "payload" });
  runtime.prepareTxForCommit(tx);
  const result = await tx.commit();
  if (result.error) throw result.error;
}

/**
 * Stages `depth` objects with `width` references to the next object at each
 * level, plus a holder referring to the first object. Preparation is left to
 * the caller so its work can be measured separately from staging.
 */
export function stageReferenceGraph(
  runtime: Runtime,
  space: MemorySpace,
  depth: number,
  width: number,
  order: "top-down" | "bottom-up",
  name = "reference-graph",
) {
  const tx = runtime.edit();
  const leaf = runtime.getCell(space, "reference-graph-leaf", undefined, tx);
  const nodes = Array.from(
    { length: depth },
    (_, index) => runtime.getCell(space, `${name}-${index}`, objectSchema, tx),
  );
  const holder = runtime.getCell(
    space,
    `${name}-holder`,
    objectSchema,
    tx,
  );
  const stages = nodes.map((node, index) => () => {
    const target = nodes[index + 1] ?? leaf;
    const fields = Array.from({ length: width }, (_, j) => `p${j}`);
    node.set(Object.fromEntries(fields.map((key) => [key, target])));
    recordReferencedArgumentFields(tx, node.getAsNormalizedFullLink(), fields);
  });
  stages.unshift(() => {
    holder.set({ argument: nodes[0] ?? leaf });
    recordReferencedArgumentFields(tx, holder.getAsNormalizedFullLink(), [
      "argument",
    ]);
  });
  for (const stage of order === "bottom-up" ? stages.toReversed() : stages) {
    stage();
  }
  return { tx, holder, nodes, leaf };
}
