import {
  action,
  type Default,
  NAME,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

// The verb input contract (docs/history/plans/verb-input-contract.md): the served
// event schema is the authored interface, whether or not the body reads a
// field. `title` is read; `done` is declared and never read; `peer` is a
// declared, never-read reference and keeps a reference marker at the least
// capability. A recursive member exercises the shrink's cycle fallback.

interface PeerNode {
  name: string;
  next: PeerNode | null;
}

interface ProbeEvent {
  /** Read by the body. */
  title: string;

  /** Declared and never read. */
  done: boolean;

  /** A declared, never-read reference. */
  peer: Writable<PeerNode>;
}

interface ProbeResult {
  count: number;
}

interface ProbeOutput {
  [NAME]: string;
  entries: string[];
  add: Stream<ProbeEvent, ProbeResult>;
}

export default pattern<
  { entries?: Writable<string[] | Default<[]>> },
  ProbeOutput
>(({ entries }) => {
  const add = action<ProbeEvent, ProbeResult>((event) => {
    entries.push(event.title);
    return { count: (entries.get() ?? []).length };
  });
  return { [NAME]: "probe", entries, add };
});
