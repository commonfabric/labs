/**
 * Configures the browser `deno-web-test` launches for this package's browser
 * tests. The browser is told it has a mouse: a hover-capable fine pointer. A
 * headless browser otherwise reports whatever its platform decides, which
 * differs between a workstation and continuous integration, and a component
 * whose CSS asks `(hover: none)` would then draw differently in the two.
 */

export default {
  args: [
    "--blink-settings=primaryHoverType=2,availableHoverTypes=2," +
    "primaryPointerType=4,availablePointerTypes=4",
  ],
};
