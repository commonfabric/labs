import { cell, pattern, UI } from "commonfabric";

// FIXTURE: map-with-array-param
// Verifies: .map() on reactive array is transformed when the third parameter (array) is used
//   .map((item, index, array) => ...) → .mapWithPattern(pattern(...), {})
//   array.length → array.key("length")
// Context: All three .map() callback params (element, index, array) are used; no outer captures
export default pattern((_state) => {
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
