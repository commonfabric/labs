import { Cell, computed, Default, pattern, UI, Writable } from "commonfabric";

interface Person {
  name: string;
  rank: number;
}

interface PatternInput {
  people?: Cell<Default<Person[], []>>;
}

// FIXTURE: computed-map-in-derived-branch
// Verifies: moving a reactive computation out of a JSX slot forces the whole
//   branch into derive(), so nested maps run in compute context and stay plain
//   const peopleCount = count + " people" inside an IIFE branch → branch derive()
//   adminData.map((entry) => <li>...) → stays plain .map() inside the derive callback
// Context: opposite of computed-map-in-ternary-branch; no JSX-local rewrite is
//   available for the hoisted `peopleCount` initializer.
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
        {showAdmin
          ? (() => {
            const peopleCount = count + " people";
            return (
              <div>
                <span>{peopleCount}</span>
                <ul>
                  {adminData.map((entry) => (
                    <li>
                      {entry.isFirst ? "★ " : ""}
                      {entry.name}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })()
          : null}
      </div>
    ),
  };
});
