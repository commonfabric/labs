import { cell, pattern, UI } from "commonfabric";

// FIXTURE: map-single-capture
// Verifies: .map() with length guard is transformed to when() + mapWithPattern()
//   people.get().length > 0 && <ul>{people.map((person, index) => <li>)}</ul>
//   → when(lift(...)(...length), <ul>{people.mapWithPattern(pattern(...))}</ul>)
export default pattern((_state) => {
  const people = cell([
    { id: "1", name: "Alice" },
    { id: "2", name: "Bob" },
  ]);

  return {
    [UI]: (
      <div>
        {people.get().length > 0 && (
          <ul>
            {people.map((person, index) => (
              <li key={index}>{person.name}</li>
            ))}
          </ul>
        )}
      </div>
    ),
  };
});
