import { cell, pattern, UI } from "commonfabric";

// FIXTURE: map-nested-conditional
// Verifies: when() guard around mapWithPattern() with nested when() inside the map body
//   showList && <div>{items.map(item => <div>{item.name && <span>}</div>)}</div>
//   → when(showList, <div>{items.mapWithPattern(pattern(... when(item.name, <span>)))}</div>)
export default pattern((_state) => {
  const items = cell([{ name: "apple" }, { name: "banana" }]);
  const showList = cell(true);

  return {
    [UI]: (
      <div>
        {showList && (
          <div>
            {items.map((item) => (
              <div>
                {item.name && <span>{item.name}</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    ),
  };
});
