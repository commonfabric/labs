/**
 * Configures the browser `deno-web-test` launches for this package's browser
 * tests. Continuous integration runs as a user that cannot open Chrome's own
 * sandbox, so the flag that turns it off is passed there and nowhere else.
 *
 * The tests read back pixels the runners page draws. Continuous integration
 * runs on machines without a GPU, where Chrome draws 2D canvases on the CPU,
 * and its CPU rasterizer shades a shape's edges differently from its GPU one.
 * Every run draws 2D canvases on the CPU, so a run on a developer's machine
 * draws them as continuous integration does.
 */

const canvasOnCpu = "--disable-accelerated-2d-canvas";

export default {
  args: Deno.env.get("CI") ? [canvasOnCpu, "--no-sandbox"] : [canvasOnCpu],
};
