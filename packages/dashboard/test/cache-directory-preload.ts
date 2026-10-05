// Runs before every test module in this package (wired in through `--preload`
// on the package's `deno-test` task). It points `DASHBOARD_CACHE_DIR` at a
// directory made for this process, and removes that directory as the process
// unloads. The dashboard's stores keep their files under that variable, and
// fall back to the machine's temporary directory without it, where a test
// would read what an earlier run or a running dashboard left there. A value
// the environment already holds is replaced for the same reason.

const directory = Deno.makeTempDirSync({ prefix: "dashboard-test-cache-" });
Deno.env.set("DASHBOARD_CACHE_DIR", directory);
globalThis.addEventListener("unload", () => {
  Deno.removeSync(directory, { recursive: true });
});
