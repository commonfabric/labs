import { action, NAME, pattern, type Stream, Writable } from "commonfabric";

// FIXTURE: contract-authored-shapes
// Verifies: contract mode serves every schema-generatable authored event
// shape verbatim — a discriminated union keeps both variants, an array event
// keeps its element type, a primitive event keeps its type, and an
// intersection's unread reference member goes opaque (verb-input-contract.md).

type UnionEv = { kind: "a"; a: number } | { kind: "b"; b: string };
type SectionEv = { base: string } & { extra: Writable<{ z: number }> };

interface Out {
  [NAME]: string;
  log: string[];
  addUnion: Stream<UnionEv, { ok: boolean }>;
  addArr: Stream<string[], { n: number }>;
  addStr: Stream<string, { n: number }>;
  addSection: Stream<SectionEv, { ok: boolean }>;
}

export default pattern<{ log?: Writable<string[]> }, Out>(({ log }) => {
  const addUnion = action<UnionEv, { ok: boolean }>((event) => {
    log?.push(event.kind);
    return { ok: true };
  });
  const addArr = action<string[], { n: number }>((event) => ({
    n: event.length,
  }));
  const addStr = action<string, { n: number }>((event) => ({
    n: event.length,
  }));
  const addSection = action<SectionEv, { ok: boolean }>((event) => {
    log?.push(event.base);
    return { ok: true };
  });
  return { [NAME]: "p", log: log!, addUnion, addArr, addStr, addSection };
});
