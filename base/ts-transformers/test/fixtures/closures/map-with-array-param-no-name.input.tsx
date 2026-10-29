import { cell, pattern, UI } from "commonfabric";

// FIXTURE: map-with-array-param-no-name
// Verifies: .map() with array param works when pattern uses inline type annotation
//   .map((item, index, array) => ...) → .mapWithPattern(pattern(...), {})
//   array.length → array.key("length")
// Context: Same as map-with-array-param but with (_state: any) inline annotation instead of type arg
export default pattern((_state: any) => {
  const items = cell([1, 2, 3, 4, 5]);

  return {
    [UI]: (
      <div>
        {items.map((item, index, array) => (
          <div>
            Item {item} at index {index} of {array.length} total items
          </div>
        ))}
      </div>
    ),
  };
});
