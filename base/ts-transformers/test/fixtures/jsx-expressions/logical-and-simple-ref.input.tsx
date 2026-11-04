import { cell, pattern, UI } from "commonfabric";

// FIXTURE: logical-and-simple-ref
// Verifies: simple opaque ref && <JSX> is transformed to when() for short-circuit rendering
//   showPanel && <div>Panel content</div> → when(showPanel, <div>Panel content</div>)
//   userName && <span>Hello</span>        → when(userName, <span>Hello</span>)
export default pattern((_state) => {
  const showPanel = cell(true);
  const userName = cell("Alice");

  return {
    [UI]: (
      <div>
        {/* Simple opaque ref with JSX on right - SHOULD use when for short-circuit optimization */}
        {showPanel && <div>Panel content</div>}

        {/* Another simple ref */}
        {userName && <span>Hello {userName}</span>}
      </div>
    ),
  };
});
