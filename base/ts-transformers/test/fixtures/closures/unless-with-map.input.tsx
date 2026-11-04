/**
 * Test case for unless() with a reactive array map as the fallback.
 *
 * unless(condition, fallback) returns condition if truthy, else fallback.
 * When fallback is items.map(...), the map gets transformed to mapWithPattern.
 * Schema injection needs to know the type of the mapWithPattern result.
 */

import { Cell, Default, pattern, UI } from "commonfabric";

interface Item {
  label: string;
}

interface PatternInput {
  customContent: Cell<any>;
  items: Cell<Default<Item[], []>>;
}

// FIXTURE: unless-with-map
// Verifies: || operator becomes unless() with reactive map as fallback
//   customContent || items.map(...) → unless(customContent, items.mapWithPattern(...))
//   items.map((item) => ...) → items.mapWithPattern(pattern(...))
// Context: unless(condition, fallback) returns condition if truthy, else fallback.
//   The fallback branch contains a reactive .map() that must be transformed to
//   mapWithPattern with proper schema injection.
export default pattern<PatternInput>(({ customContent, items }) => {
  return {
    [UI]: (
      <div>
        {/* unless(condition, fallback) where fallback is a reactive map */}
        {customContent || items.map((item) => <li>{item.label}</li>)}
      </div>
    ),
  };
});
