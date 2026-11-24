import { action, NAME, pattern, type Stream, Writable } from "commonfabric";

// FIXTURE: contract-nested-unread-reference
// Verifies: a declared, never-read field whose subtree holds a reference
// serves its authored structure with the nested reference OPAQUE — the
// contract names it, the grant confers nothing (verb-input-contract.md).
interface Inner { n: number; }
interface Box { label: string; inner: Writable<Inner>; }
interface Ev { title: string; box: Box; }
interface Out { [NAME]: string; log: string[]; add: Stream<Ev, { ok: boolean }>; }
export default pattern<{ log?: Writable<string[]> }, Out>(({ log }) => {
  const add = action<Ev, { ok: boolean }>((event) => {
    log?.push(event.title);
    return { ok: true };
  });
  return { [NAME]: "p", log: log!, add };
});
