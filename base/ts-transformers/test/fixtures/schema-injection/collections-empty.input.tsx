import { Writable, pattern } from "commonfabric";

// FIXTURE: collections-empty
// Verifies: empty arrays and objects produce valid degenerate schemas
//   cell([]) → cell([], { type: "array", items: false })
//   cell({}) → cell({}, { type: "object", properties: {} })
export default pattern(() => {
  // Empty array
  const _emptyArray = new Writable<string[]>([]);

  // Empty object
  const _emptyObject = new Writable({});

  return {
    emptyArray: _emptyArray,
    emptyObject: _emptyObject,
  };
});
