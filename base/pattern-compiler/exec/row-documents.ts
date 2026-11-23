/**
 * Which collections of a plan have their rows stored as documents of their
 * own (provisional decision P54, note 575 of `SPEC-NOTES.md`): a `map` in no
 * element body, over an array of references by what the plan declares,
 * whose rows are records or view nodes. The rule reads the plan alone, so the boundary
 * of a document never follows the data or a label.
 */
import type { Artifact } from "./executor.ts";
import type { Schema } from "./store.ts";

/** Whether a schema declares an array, or its members, as cells. */
const declaresReferences = (schema: Schema | undefined): boolean =>
  typeof schema === "object" &&
  (schema.asCell !== undefined ||
    (typeof schema.items === "object" && schema.items.asCell !== undefined));

/** Whether a schema declares the values of a record's entries as cells. */
const declaresReferenceEntries = (schema: Schema | undefined): boolean => {
  if (typeof schema !== "object") return false;
  const { additionalProperties } = schema as {
    additionalProperties?: Schema;
  };
  return typeof additionalProperties === "object" &&
    additionalProperties.asCell !== undefined;
};

/**
 * The collections of the plan of `artifact` whose rows are stored as
 * documents of their own:
 *
 * - the construct is `map`, and it is written in no element body;
 * - its source is a slot whose schema declares the array or its members as
 *   cells, the entries of a record whose schema declares its values as
 *   cells, the result of a `lift` or a `computed` whose body gives a
 *   reference at each member (`Body.outputs` at `*`), or a `filter` or a
 *   `sortBy` over such a source, which gives the same references;
 * - the plan has an output below a row, so a row is a record or a view node
 *   and no scalar.
 *
 * A `map` over an array of plain values in place, and one over the result
 * of a body that gives plain values, keep their rows in place: the plan
 * does not say of either that a member has an identity apart from its
 * position.
 */
export const rowDocumentCollections = (artifact: Artifact): Set<number> => {
  const { plan } = artifact;
  const schemas = new Map(
    artifact.schemas.map(({ id, schema }) => [id, schema as Schema]),
  );
  const references = (index: number): boolean => {
    const { source } = plan.collections[index];
    if (source.slot !== undefined) {
      const slot = plan.slots[source.slot];
      if (slot.schema === undefined) return false;
      // A collection over the entries of a record has a reference at each
      // entry where the record declares its values as cells.
      return source.entries === true
        ? declaresReferenceEntries(schemas.get(slot.schema))
        : declaresReferences(schemas.get(slot.schema));
    }
    if (source.output !== undefined) {
      const output = plan.outputs[source.output];
      return (plan.cones[output?.cone]?.bodies ?? []).some((body) =>
        (plan.bodies[body].outputs ?? []).some(({ path, reference }) =>
          path.length === 1 && path[0] === "*" && reference !== undefined
        )
      );
    }
    return source.collection !== undefined &&
      (plan.collections[source.collection].construct === "filter" ||
        plan.collections[source.collection].construct === "sortBy") &&
      references(source.collection);
  };
  const found = new Set<number>();
  plan.collections.forEach((collection, index) => {
    if (collection.construct !== "map") return;
    if (collection.within.some((step) => step.element !== undefined)) return;
    if (!references(index)) return;
    const place = plan.outputs.find((output) => output.collection === index);
    if (place === undefined) return;
    const below = plan.outputs.some((output) =>
      output.path.length > place.path.length + 1 &&
      output.path[place.path.length] === "*" &&
      place.path.every((segment, at) => segment === output.path[at])
    );
    if (below) found.add(index);
  });
  return found;
};

/**
 * The collections of the plan of `artifact` whose index is stored with each
 * bucket as a document of its own: a `groupBy` or a `keyBy` that is written
 * in no element body and that the result keeps at a path through no
 * element. The result document then holds a link to each bucket, and a
 * member that changes its key writes the documents of two buckets.
 */
export const bucketDocumentCollections = (artifact: Artifact): Set<number> => {
  const { plan } = artifact;
  const found = new Set<number>();
  for (const output of plan.outputs) {
    if (
      output.kept !== true || output.collection === undefined ||
      output.path.includes("*")
    ) continue;
    const collection = plan.collections[output.collection];
    if (
      (collection.construct === "groupBy" ||
        collection.construct === "keyBy") && collection.within.length === 0
    ) found.add(output.collection);
  }
  return found;
};
