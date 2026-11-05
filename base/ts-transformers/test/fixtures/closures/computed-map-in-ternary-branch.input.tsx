import { Cell, computed, Default, pattern, UI, Writable } from "commonfabric";

interface Person {
  name: string;
  rank: number;
}

interface PatternInput {
  people?: Cell<Default<Person[], []>>;
}

// FIXTURE: computed-map-in-ternary-branch
// Verifies: a computed array used inside a ternary JSX branch stays pattern-lowered
//   const adminData = computed(() => [...people.get()].sort(...).map(...))
//   adminData.map((entry) => <li>...) → adminData.mapWithPattern(pattern(...))
//   showAdmin ? <div>...</div> : null → ifElse(showAdmin, <div>...</div>, null)
// Context: The outer `people.map(...)` is over a pattern input cell, while the
//   inner `adminData.map(...)` is over compute-owned data but still lowered in
//   pattern context when rendered from the ternary branch.
export default pattern<PatternInput>(({ people }) => {
  const showAdmin = new Writable(false);

  const adminData = computed(() =>
    [...people.get()]
      .sort((a, b) => a.rank - b.rank)
      .map((p) => ({ name: p.name, rank: p.rank, isFirst: p.rank === 1 }))
  );

  const count = computed(() => people.get().length);

  return {
    [UI]: (
      <div>
        {people.map((person) => (
          <span>{person.name}</span>
        ))}
        {showAdmin
          ? (
            <div>
              <span>{count + " people"}</span>
              <ul>
                {adminData.map((entry) => (
                  <li>
                    {entry.isFirst ? "★ " : ""}
                    {entry.name}
                  </li>
                ))}
              </ul>
            </div>
          )
          : null}
      </div>
    ),
  };
});
