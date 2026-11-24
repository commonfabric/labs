/**
 * How the adapter of a compiled piece names a document of another space
 * than the piece's for the executor.
 *
 * The executor names a document by one text. A document of the space of
 * the piece is named by its entity, or by an identifier of the executor's
 * own, and a document of another space by its entity and that space: two
 * spaces can hold documents of one entity, and the name of a source in the
 * basis of a piece says which replica holds it. An entity named `data:`
 * holds the value its name encodes in every space, and is named by the
 * entity alone.
 */

/** What stands between the entity and the space in a name. */
const IN = "@";

/** The name of the document that `space` holds at `entity`. */
export const documentIn = (entity: string, space: string): string =>
  `${entity}${IN}${space}`;

/**
 * The entity or the executor's identifier that a name of a document
 * begins with, and the space it names, where it names one.
 */
export const placeOfDocument = (
  doc: string,
): { named: string; space?: string } => {
  if (doc.startsWith("data:")) return { named: doc };
  const at = doc.indexOf(IN);
  return at < 0
    ? { named: doc }
    : { named: doc.slice(0, at), space: doc.slice(at + IN.length) };
};
