// Runs before every test module in this package (wired in through `--preload`
// on the package's `deno-test` task). It points `DASHBOARD_CACHE_DIR` at a
// directory made for this process, and removes that directory as the process
// unloads. The dashboard's stores keep their files under that variable, and
// fall back to the machine's temporary directory without it, where a test
// would read what an earlier run or a running dashboard left there. A value
// the environment already holds is replaced for the same reason.
//
// It also removes the variables that configure the dashboard's GitHub
// credentials. A test that wants one sets it, and a credential the shell
// happened to hold would otherwise reach GitHub, or take precedence over the
// one the test set.

const directory = Deno.makeTempDirSync({ prefix: "dashboard-test-cache-" });
Deno.env.set("DASHBOARD_CACHE_DIR", directory);
globalThis.addEventListener("unload", () => {
  Deno.removeSync(directory, { recursive: true });
});

for (
  const variable of [
    "GH_APP_CLIENT_ID",
    "GH_APP_PRIVATE_KEY",
    "GH_BILLING_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]
) {
  Deno.env.delete(variable);
}
