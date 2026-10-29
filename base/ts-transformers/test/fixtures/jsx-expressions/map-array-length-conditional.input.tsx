import { cell, pattern, UI } from "commonfabric";

// FIXTURE: map-array-length-conditional
// Verifies: length-guard && map pattern is transformed to when() wrapping mapWithPattern()
//   list.get().length > 0 && (<div>{list.map(...)}</div>) → when(lift(...)(...length), <div>{list.mapWithPattern(...)}</div>)
export default pattern((_state) => {
  const list = cell(["apple", "banana", "cherry"]);

  return {
    [UI]: (
      <div>
        {list.get().length > 0 && (
          <div>
            {list.map((name) => (
              <span>{name}</span>
            ))}
          </div>
        )}
      </div>
    ),
  };
});
