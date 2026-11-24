import { computed, pattern, UI } from "commonfabric";

interface Spot {
  active: boolean;
  spotNumber: string;
  label?: string;
}

interface Person {
  name: string;
  email: string;
  commuteMode: string;
  priorityRank: number;
  defaultSpot?: string;
  spotPreferences: string[];
  isFirst: boolean;
  isLast: boolean;
}

interface State {
  people: Person[];
  editingPersonName: string | null;
  removePersonConfirmTarget: string | null;
  spots: Spot[];
}

// FIXTURE: map-parking-style-join
// Verifies: nested plain-array joins inside a reactive map callback stay plain in complex branches
//   state.people.map(fn)                    -> state.key("people").mapWithPattern(pattern(...), ...)
//   state.spots.filter(...).map(... )       -> lift(...)(...).filter(...).map(...) stays plain inside computed()
//   spotPreferences.map((n) => "#" + n)     -> nested plain-array callback stays plain and does not capture n
// Context: Realistic callback body mixing computed aliases, destructuring, conditional JSX, and joined plain-array labels
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {state.people.map((person) => {
          const {
            name: personName,
            email,
            commuteMode,
            priorityRank,
            defaultSpot,
            spotPreferences,
            isFirst,
            isLast,
          } = person;
          const isEditing = computed(() =>
            state.editingPersonName === personName
          );
          const isRemoveConfirm = computed(() =>
            state.removePersonConfirmTarget === personName
          );
          const activeSpotOpts = computed(() =>
            state.spots
              .filter((s) => s.active)
              .map((s) => ({
                label: "#" + s.spotNumber + (s.label ? " - " + s.label : ""),
                value: s.spotNumber,
              }))
          );

          return (
            <section>
              <span>{personName}</span>
              <span>{email}</span>
              <span>{commuteMode}</span>
              <span>{priorityRank}</span>
              {defaultSpot ? <span>{defaultSpot}</span> : null}
              {isFirst ? <span>first</span> : null}
              {isLast ? <span>last</span> : null}
              {isEditing ? <span>editing</span> : null}
              {isRemoveConfirm ? <span>removing</span> : null}
              {activeSpotOpts.length > 0 ? <span>spots</span> : null}
              {spotPreferences.length > 0
                ? (
                  <span>
                    Prefers: {spotPreferences.map((n) => "#" + n).join(", ")}
                  </span>
                )
                : null}
            </section>
          );
        })}
      </div>
    ),
  };
});
