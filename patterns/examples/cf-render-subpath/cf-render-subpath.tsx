/**
 * Test pattern for cf-render subpath behavior.
 *
 * This pattern tests the fix for the cf-render regression where subpath cells
 * like .key("sidebarUI") that intentionally return undefined were being
 * incorrectly blocked by the async-loading detection logic.
 *
 * The pattern has:
 * - A main UI (always present)
 * - sidebarUI: explicitly undefined (should NOT block rendering)
 * - [TILE_UI]: a valid UI (should render when accessed via variant)
 */
import { computed, Default, NAME, pattern, TILE_UI, UI } from "commonfabric";

interface State {
  title: string | Default<"Test Pattern">;
}

export default pattern<State>((state) => {
  return {
    [NAME]: computed(() => `Subpath Test: ${state.title}`),
    [UI]: (
      <div id="main-ui">
        <h1>{state.title}</h1>
        <p>This is the main UI. sidebarUI is intentionally undefined.</p>
      </div>
    ),
    // Explicitly undefined - cf-render should NOT wait forever for this
    // For now, exclude the sidebarUI property entirely -- having it in our
    // returned value makes the transformer think it should be required,
    // but since it's undefined, our object won't match the schema.
    //sidebarUI: undefined,
    // Valid UI for testing variant rendering
    [TILE_UI]: (
      <div id="preview-ui">
        <span>Preview: {state.title}</span>
      </div>
    ),
    title: state.title,
  };
});
