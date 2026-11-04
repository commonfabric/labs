import { pattern, UI } from "commonfabric";

interface Vote {
  optionId: string;
  voterName: string;
}

// FIXTURE: array-method-value-lift
// Verifies (CT-1777): a bare reactive VALUE-expression in the return position of a
// reactive map/filter/flatMap callback is lifted to a value-level lift, so it runs on
// resolved values instead of being emitted raw on Reactive proxies. Before CT-1777 a
// filter predicate `v.optionId === oid` compiled to a proxy-vs-proxy `===` — reference
// equality, i.e. a constant `false` — so the filter matched nothing (silent, type-clean).
//   - filter predicate comparison      → filterWithPattern(pattern(... return lift(...)(...)))
//   - map -> non-JSX comparison        → mapWithPattern(pattern(... return lift(...)(...)))
//   - flatMap -> array-element compare → flatMapWithPattern(pattern(... return [lift(...)(...)]))
// Collection-valued `??` fallbacks and logical `&&`/`||` stay structural / control-flow
// lowered; see filter-flatmap-fallback-chain for the structural-collection counterpart.
export default pattern<{ votes: Vote[]; oid: string }>(({ votes, oid }) => {
  return {
    [UI]: (
      <div>
        {/* filter predicate: the comparison must be lifted to value level */}
        <div>
          {votes
            .filter((v) => v.optionId === oid)
            .map((v) => <i>{v.voterName}</i>)}
        </div>
        {/* map to a bare non-JSX boolean: the comparison must be lifted */}
        <div>{votes.map((v) => v.optionId === oid)}</div>
        {/* flatMap returning an array whose element is a comparison: must be lifted */}
        <div>{votes.flatMap((v) => [v.optionId === oid])}</div>
      </div>
    ),
  };
});
