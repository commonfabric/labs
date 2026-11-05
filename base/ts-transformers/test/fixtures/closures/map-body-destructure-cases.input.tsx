import { pattern, UI } from "commonfabric";

interface Spot {
  spotNumber: string;
}

interface Person {
  name: string;
  spotPreferences: string[];
}

interface State {
  spots: Spot[];
  people: Person[];
}

// FIXTURE: map-body-destructure-cases
// Verifies: body-local destructuring inside reactive .map() callbacks lowers to key() access
//   const { spotNumber: sn } = spot        -> sn bound from spot.key("spotNumber")
//   const { name, spotPreferences } = ...  -> both aliases lowered from person.key(...)
//   spotPreferences.length                 -> spotPreferences.key("length")
//   spotPreferences.map(...).join(", ")    -> nested plain-array callback stays plain
// Context: Covers destructuring aliases declared inside the callback body, not only in the parameter list
export default pattern<State>((state) => {
  return {
    [UI]: (
      <section>
        <ul>
          {state.spots.map((spot) => {
            const { spotNumber: sn } = spot;
            return <li>{sn}</li>;
          })}
        </ul>

        <ul>
          {state.people.map((person) => {
            const { name, spotPreferences } = person;
            return (
              <li>
                <span>{name}</span>
                {spotPreferences.length > 0
                  ? <span>{spotPreferences.map((n) => "#" + n).join(", ")}</span>
                  : null}
              </li>
            );
          })}
        </ul>
      </section>
    ),
  };
});
