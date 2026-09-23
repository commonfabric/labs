/**
 * The reserved keys the framework puts on a pattern result.
 *
 * Their spellings belong to the framework rather than to anything the pattern
 * computed. Two packages act on that fact and neither may import the other —
 * the runner builds the results and reads the keys back off them, and the
 * transformer decides what a pattern may declare about them — so the spelling
 * lives here, where both reach it.
 */

// Should be Symbol("UI") or so, but this makes repeat() use these when
// iterating over patterns.
export const TYPE = "$TYPE";
export const NAME = "$NAME";
export const UI = "$UI";
// UI variants: optional sibling renderings addressed alongside [UI].
// chip = inline, tile = gallery/grid card; absent variants fail over to a
// per-variant default (see uiVariant()), with [UI] as the universal floor.
export const TILE_UI = "$TILE_UI";
export const CHIP_UI = "$CHIP_UI";
export const FS = "$FS";
// The single field under which a pattern offers named groups of facts and
// streams a host may draw with its own toolkit — `{ inboxView: … }` — as [UI]
// and [FS] are single fields. One field is one round of discovery: a host
// reads it through a schema to learn what is on offer before anything under
// it is derived. [UI] remains the floor every host can draw.
export const VIEWS = "$VIEWS";
// The reserved key a test pattern addresses its test steps under; the test
// runner reads `[TESTS]` off the pattern output.
export const TESTS = "$TESTS";

/**
 * Every reserved key the framework puts on a pattern result: the type marker,
 * the display name, the rendering variants, the filesystem view, the test
 * steps, and the offered views. A reader that describes only the computed
 * fields excuses these by name instead of failing on them, and a pattern that
 * declares one of them at the root of its own result is describing a value it
 * produced.
 */
export const FRAMEWORK_RESULT_KEYS = [
  TYPE,
  NAME,
  UI,
  TILE_UI,
  CHIP_UI,
  FS,
  TESTS,
  VIEWS,
] as const;
