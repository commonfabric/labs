import { pattern, UI } from "commonfabric";

interface Row {
  name?: string;
  active?: boolean;
  primary?: string[];
  fallback: number[];
}

// FIXTURE: array-method-scalar-nullish-lift
// Verifies (CT-1779): a SCALAR nullish-coalescing `??` with a reactive operand in the
// return / predicate position of a reactive map/filter/flatMap callback is value-lifted,
// so the `?? default` fallback runs on the RESOLVED value. Emitted raw, `v.name ?? "d"`
// collapses to the bare field projection — a Reactive proxy is never null and `??`
// can't be trapped — so the default is silently dropped (type-clean, no error).
//   - scalar string `??`        → mapWithPattern(pattern(... return lift(... r.name ?? "default")))
//   - scalar boolean `??` (pred) → filterWithPattern(pattern(... return lift(... r.active ?? true)))
// A COLLECTION-valued `??` must stay structural so the runtime *WithPattern flattens it.
// CT-1777 keyed the exclusion on operand provenance, which over-excluded scalar `??`;
// CT-1779 keys it on RESULT type. The homogeneous `i.tags ?? []` case is pinned by
// filter-flatmap-fallback-chain; here the heterogeneous `r.primary ?? r.fallback`
// (`string[] | number[]`, a union of array members a bare isArrayType misses) stays
// structural too.
export default pattern<{ rows: Row[] }>(({ rows }) => {
  return {
    [UI]: (
      <div>
        {/* scalar string ??: lifted, so "default" is live */}
        <div>{rows.map((r) => r.name ?? "default")}</div>
        {/* scalar boolean ?? as a filter predicate: lifted */}
        <div>
          {rows.filter((r) => r.active ?? true).map((r) => <i>{r.name}</i>)}
        </div>
        {/* heterogeneous collection ?? (union of array types): stays structural */}
        <div>{rows.map((r) => r.primary ?? r.fallback)}</div>
      </div>
    ),
  };
});
