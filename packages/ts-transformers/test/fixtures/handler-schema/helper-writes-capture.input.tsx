import { Default, handler, Writable } from "commonfabric";

type Count = Writable<number | Default<0>>;

function bump(count: Count): void {
  count.set(count.get() + 1);
}

// Declared without a body, so the analysis has no summary of what it reads.
declare function audit(value: unknown): void;

function bumpAudited(count: Count): void {
  const current = count.get();
  audit(current);
  count.set(current + 1);
}

function currentOf(count: Count): number {
  return count.get();
}

const viaHelper = handler<void, { count: Count }>((_, { count }) => {
  bump(count);
});

const viaAuditedHelper = handler<
  void,
  { count: Count; label: Writable<{ text: string; color: string }> }
>((_, { count, label }) => {
  bumpAudited(count);
  return label.get().text;
});

const viaReadingHelper = handler<void, { count: Count; out: Writable<number> }>(
  (_, { count, out }) => {
    out.set(currentOf(count));
  },
);

// FIXTURE: helper-writes-capture
// Verifies: a handler's state capture handed to a helper the same file
// declares is charged what the helper does with it
//   bump(count)        → count: asCell ["cell"] (read and written there)
//   bumpAudited(count) → count: asCell ["cell"], though the helper also hands
//                        the value to a function with no body to analyze;
//                        label beside it still narrows to the `text` it reads
//   currentOf(count)   → count: asCell ["readonly"] (only read there)
export { viaAuditedHelper, viaHelper, viaReadingHelper };
