/**
 * Configures the browser `deno-web-test` launches for this package's browser
 * tests. Continuous integration runs as a user that cannot open Chrome's own
 * sandbox, so the flag that turns it off is passed there and nowhere else.
 */

export default {
  args: Deno.env.get("CI") ? ["--no-sandbox"] : [],
};
