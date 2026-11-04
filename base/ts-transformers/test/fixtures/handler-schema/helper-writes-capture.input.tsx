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

type Message = { body: string; sentAt: number };

function describe(message: Writable<Message>): string {
  const body = () => message.get().body;
  return String(message.get().sentAt) + body();
}

function describeInline(message: Writable<Message>): string {
  return String(message.get().sentAt) + (() => message.get().body)();
}

function editLater(message: Writable<Message>, text: string): () => void {
  const edit = () => message.key("body").set(text);
  edit();
  return edit;
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

const viaNestedRead = handler<
  void,
  { message: Writable<Message>; out: Writable<string> }
>((_, { message, out }) => {
  out.set(describe(message));
});

const viaInlineRead = handler<
  void,
  { message: Writable<Message>; out: Writable<string> }
>((_, { message, out }) => {
  out.set(describeInline(message));
});

const viaNestedWrite = handler<{ text: string }, { message: Writable<Message> }>(
  ({ text }, { message }) => {
    editLater(message, text);
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
//   describe(message)  → message keeps `body`, read in a closure the helper
//                        declares, beside `sentAt`
//   describeInline     → the same through an immediately invoked arrow
//   editLater(message) → message: asCell ["cell"], written in a closure
export {
  viaAuditedHelper,
  viaHelper,
  viaInlineRead,
  viaNestedRead,
  viaNestedWrite,
  viaReadingHelper,
};
