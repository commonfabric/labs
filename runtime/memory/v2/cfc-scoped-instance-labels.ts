/**
 * What a reader of one scope instance of a document answers to in the stored
 * CFC envelopes of the broader instances of the same document
 * (`docs/specs/scoped-cell-instances.md`, "Storage Model").
 *
 * The space, user and session instances of one id are instances of one cell,
 * each holding a value and an envelope of its own, and a narrower instance's
 * content is reached through the broader instance's slot. Reading that
 * content needs both authorizations: the reader must meet the broader
 * instance's confidentiality as well as the narrower one's, the conjunction
 * CFC asks of per-user content reached through a shared slot (§4.9.4). A
 * broader instance can also be the only place a label of the narrower
 * content is stored: the flow stamp of a whole value a writer set is
 * recorded where the writer set it, and an instance written before narrowed
 * writes stamped the instance's own envelope stores none of the labels its
 * slot's schema declares.
 *
 * Two readers hold to this rule, and so answer to the same entries: the
 * runner's (`cfc/metadata.ts` in `@commonfabric/runner`), for the cell label
 * views and the runtime read ceiling, and the engine's labeling of the
 * anchors an edit moves (`cfc-anchors-label.ts`), which takes on what a
 * reader of the field answers to. Reading the envelopes, and producing a
 * label from the entries selected, stay with each reader.
 */

import type { CellScope } from "../v2.ts";
import { readConsumesEntry } from "./cfc-observation-classes.ts";

const BROADER_SCOPES: Readonly<Record<CellScope, readonly CellScope[]>> = {
  space: [],
  user: ["space"],
  session: ["user", "space"],
};

/**
 * The scopes of the instances of a document broader than its instance of
 * scope `scope`, nearest first: the space instance for a user instance, and
 * the user and space instances for a session instance.
 */
export const broaderCellScopes = (scope: CellScope): readonly CellScope[] =>
  BROADER_SCOPES[scope];

/**
 * The entries a reader of a narrower instance's content answers to, out of
 * `broader`, the label-map entries each broader instance of the document
 * stores, `undefined` standing for an instance that stores none: those a
 * read of the value consumes (`readConsumesEntry()`), in the order given.
 * That is the covering entries and the content classes, declared and
 * derived alike.
 *
 * An entry for the pointer the broader slot holds, a `followRef` entry or a
 * link-origin one with no class, is not one of them. It copies the labels of
 * the instance the redirect's writer narrowed into, and every user's
 * redirect is that one stored link, so it speaks for whichever user's write
 * stored it and not for the content of the instance being read. Neither is
 * a label-metadata template, which no read of a value consumes.
 *
 * A caller takes the confidentiality of each entry returned and never its
 * integrity. Integrity speaks for whoever wrote the value, and whoever
 * wrote the broader instance did not write the narrower one: a claim stored
 * there would otherwise vouch for a later, less trusted write here.
 *
 * Paths line up across the instances, since narrowed content sits at the
 * path of the slot that redirects to it, so a caller compares an entry's
 * path with a path in the narrower instance as it stands.
 */
export const broaderEntriesForReader = <
  Entry extends { readonly origin?: unknown; readonly observes?: unknown },
>(
  broader: readonly (readonly Entry[] | undefined)[],
): Entry[] =>
  broader.flatMap((entries) =>
    (entries ?? []).filter((entry) => readConsumesEntry("value", entry))
  );
