/**
 * A composition template checked against the mailbox reader's source by the
 * compiler test. The caller substitutes an inspected index id and uses that
 * record's argument and result contracts.
 */
export const PATTERN_COMPOSITION_EXAMPLE =
  `import { computed, pattern, type SqliteDb, type VNode } from "commonfabric";
import ReadHeaders from "cf:pattern:INSPECTED_READER_ID";

interface Input { mail: SqliteDb; }
export interface Output {
  $NAME: string;
  $UI: VNode;
  pending: boolean;
  errorMessage: string;
  headerCount: number;
}

export default pattern<Input, Output>(({ mail }) => {
  const read = ReadHeaders({ mail, limit: 20 });
  const labels = computed(() => read.headers.map((header) => ({
    subject: header.subject,
    day: header.received_at.slice(0, 10),
  })));
  return {
    $NAME: "Mail headers",
    pending: read.pending,
    errorMessage: read.errorMessage,
    headerCount: read.headerCount,
    $UI: <div>{read.pending ? <span>Loading…</span>
      : read.errorMessage ? <cf-alert status="error">{read.errorMessage}</cf-alert>
      : <div>{read.headerCount} headers in this sample
        {labels.map((row) => <div>{row.day}: {row.subject}</div>)}
      </div>}</div>,
  };
});`;

/**
 * Compiler and value-boundary rules for an author writing new pattern source.
 * Research does not carry them: it chooses published parts, which are
 * imported rather than rewritten, on their contract rather than their source.
 */
export const PATTERN_AUTHORING_GUIDANCE = [
  'Use cf-alert status="info" | "error" | "warning" | "success". It has no variant or severity prop.',
  "Pattern inputs and outputs must be serializable: use arrays or plain records, not Set or Map. A temporary Set inside a computed is local working state; return an array from it, not the Set.",
  "Keep pattern-owned callbacks straight-line: no for, for-of, for-in, or while statements, including inside mapped JSX callbacks. Use array methods or move imperative iteration into computed(), module-scope lift(), or a helper called inside those computations.",
  "A TypeScript string annotation does not unwrap a reactive reference. For scalar formatting such as date.slice(0, 10), read the value inside computed()/lift() and call the formatter there; use .get() there for an explicitly cell-typed value. If v.slice is not a function, check the actual input shape and the call's reactive context; a type assertion or String(reference) does not repair the binding.",
].join("\n");

/** A small reader composition with its schema and identity assumptions explicit. */
export const PATTERN_COMPOSITION_GUIDANCE = [
  "Import an inspected reader and wire its result; do not reproduce its query from its description. This template assumes the mailbox reader contract (mail: SqliteDb; headers, headerCount, pending, errorMessage). Replace INSPECTED_READER_ID with the exact inspected id; never submit the placeholder or assume a different reader has these fields. Pass the mail handle through run_pattern inputs. The count is a bounded sample count, not the mailbox total. Preserve pending and error when composing.",
  "```tsx",
  PATTERN_COMPOSITION_EXAMPLE,
  "```",
].join("\n");
