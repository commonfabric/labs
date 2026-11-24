import { cell, pattern, UI } from "commonfabric";

// FIXTURE: map-single-capture-no-name
// Verifies: same map + length guard transforms work with _state: any parameter
//   people.get().length > 0 && <ul>{people.map(...)}</ul> → when(..., <ul>{mapWithPattern(...)}</ul>)
// Context: Variant of map-single-capture with _state: any
export default pattern((_state: any) => {
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
