/**
 * When the cell a write to a value lands in is the value's own, so that the
 * one principal its label names (`soleRepresentedPrincipal()`) is the one the
 * value represents. A host holding a runtime reads it through
 * `writtenPrincipalAt()`, which the worker also applies for a host holding
 * cell handles (`observeWrittenPrincipal()` in the runtime client), and
 * pattern code through `writtenPrincipalOf()`.
 *
 * A write declared `RepresentsCurrentUser`, as a profile's `setPicture` is,
 * labels the value with the principal it acts for. That label speaks for the
 * value only when the value is the whole of the cell a write to it lands in. A
 * value at a path within a document reads with that document's label, which
 * says whom the document represents, or whom a field was installed for. A link
 * stored in the cell leads to a value the cell does not hold. The label says
 * nothing of who pointed a field at the cell: the links on the way, write
 * redirects among them, are followed, so a reader relies on the field's write
 * policy for that, as a profile's owner-protected fields provide.
 */
import { areNormalizedLinksSame, type NormalizedLink } from "../link-types.ts";

/**
 * Whether a value is the whole of the cell a write to it lands in
 * (`written`), which its links lead to unchanged (`target`): a document of
 * its own, holding the value rather than a link to it.
 */
// SPEC-PENDING https://github.com/commonfabric/specs/pull/75
export const isOwnValueCell = (
  written: NormalizedLink,
  target: NormalizedLink,
): boolean =>
  written.path.length === 0 && areNormalizedLinksSame(written, target);
