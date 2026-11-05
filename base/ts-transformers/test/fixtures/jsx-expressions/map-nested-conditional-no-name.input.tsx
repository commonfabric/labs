import { cell, pattern, UI } from "commonfabric";

// FIXTURE: map-nested-conditional-no-name
// Verifies: same nested conditional map transforms work when pattern param is typed as any
//   showList && <div>{items.map(...)}</div> → when(showList, <div>{items.mapWithPattern(...)}</div>)
// Context: Variant of map-nested-conditional with _state: any instead of named pattern
export default pattern((_state: any) => {
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
