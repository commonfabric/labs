import { env } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  type ChurnCounters,
  clickCfButton,
  clickTrustedAction,
  collectBrowserLoadSummary,
  fillCfInput,
  logBrowserLoadSummary,
  waitForRuntimeIdle,
  waitForRuntimeSynced,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { FRONTEND_URL } = env;
const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

// One stable, machine-parseable line per churn measurement, logged before the
// assertions so a run that exceeds a bound still records its value rather than
// hiding it behind the failure. The reload bounds below are read from the real
// distribution across CI runs and runners, which holds at zero. The
// `CHURN_METRIC` tag and `key=value` shape are the stable contract — keep them
// greppable.
//
// To pull the distribution from the most recent 100 CI runs (this test is a
// unit of the test topology's pattern integration suites, so it runs in a lane
// of every full run and of any pull request that selects it; PRs land on
// commonfabric/labs — adjust -R for a fork). Requires the `gh` CLI:
//
//   gh run list -R commonfabric/labs --workflow deno.yml --limit 100 \
//     --json databaseId --jq '.[].databaseId' \
//     | xargs -P4 -I{} gh run view -R commonfabric/labs {} --log 2>/dev/null \
//     | grep 'CHURN_METRIC label=reload' > /tmp/churn.txt
//
//   for k in commitConflicts commitReverts scheduleRunErrors; do
//     printf '%s:\n' "$k"
//     grep -oE "$k=[0-9]+" /tmp/churn.txt | cut -d= -f2 | sort -n | uniq -c
//   done
//
// The `uniq -c` columns are "occurrences value", so the largest value with a
// non-trivial count is the floor the bound should clear.
function logChurnMetric(label: string, churn: ChurnCounters): void {
  console.log(
    `CHURN_METRIC label=${label}` +
      ` commitConflicts=${churn.commitConflicts}` +
      ` commitReverts=${churn.commitReverts}` +
      ` scheduleRunErrors=${churn.scheduleRunErrors}` +
      ` commitRejected=${churn.commitRejected}` +
      ` actionRuns=${churn.actionRuns}` +
      ` eventLostRaces=${churn.eventLostRaces}`,
  );
}

// deno-lint-ignore no-explicit-any
async function profileTabHidden(page: any): Promise<boolean> {
  return await page.evaluate(() => {
    const deepFind = (sel: string): Element | null => {
      const stack: (Document | ShadowRoot)[] = [document];
      while (stack.length) {
        const root = stack.pop()!;
        const hit = root.querySelector(sel);
        if (hit) return hit;
        for (const e of root.querySelectorAll("*")) {
          const sr =
            (e as HTMLElement & { shadowRoot?: ShadowRoot }).shadowRoot;
          if (sr) stack.push(sr);
        }
      }
      return null;
    };
    const panel = deepFind('cf-tab-panel[value="profile"]') as
      | HTMLElement
      | null;
    return !panel || getComputedStyle(panel).display === "none";
  });
}

// deno-lint-ignore no-explicit-any
async function ensureProfileTabActive(page: any) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await waitForRuntimeIdle(page);
    if (!(await profileTabHidden(page))) return;
    await clickCfButton(page, 'cf-tab[value="profile"]');
  }
}

// deno-lint-ignore no-explicit-any
async function createProfile(page: any, name: string) {
  // `activeTab` can revert during synchronization (CT-1666); check it afterward.
  await waitForRuntimeSynced(page);
  await ensureProfileTabActive(page);
  await fillCfInput(page, "#wish-profile-picker-name-input", name);
  await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
  await waitForRuntimeSynced(page);
}

// Like createProfile but settles only with `waitForRuntimeIdle` (no
// `waitForRuntimeSynced`): a create issued while the post-reload rehydration
// window is still settling.
// deno-lint-ignore no-explicit-any
async function createProfileRacy(page: any, name: string) {
  await ensureProfileTabActive(page);
  await fillCfInput(page, "#wish-profile-picker-name-input", name);
  await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
  await waitForRuntimeIdle(page);
}

async function gotoHome(shell: ShellIntegration, identity: Identity) {
  await shell.goto({
    frontendUrl: FRONTEND_URL,
    view: { builtin: "home" },
    identity,
  });
  await clickCfButton(shell.page(), 'cf-tab[value="profile"]');
}

// Reload health for the home space. Re-instantiating the runtime against a
// populated, already-durable home is read-mostly. This guard asserts two
// observable properties:
//   1. Reloading re-commits ~nothing already-durable: commit conflicts,
//      reverts, and schedule-run-errors stay near zero, bounded rather than
//      scaling with accumulated history.
//   2. A profile created in the post-reload window (settling only on idle)
//      survives a subsequent clean reload, which renders from durable state.
describe("home rehydration", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
  });

  it("reloading a populated home re-commits nothing already-durable", async () => {
    const page = shell.page();

    await gotoHome(shell, identity);
    await createProfile(page, "Ada Lovelace");
    await waitForRuntimeIdle(page);
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");
    await waitForRuntimeSynced(page);

    // Sanity: the create itself runs reactive actions (proves the worker-side
    // counters reflect real activity in this measurement).
    const afterCreate = await collectBrowserLoadSummary(page, "after-create");
    logBrowserLoadSummary(afterCreate);
    logChurnMetric("after-create", afterCreate.churn);
    expect(afterCreate.churn.actionRuns).toBeGreaterThan(0);

    // RELOAD: re-instantiate the runtime against the populated, durable space.
    await gotoHome(shell, identity);
    await waitForRuntimeIdle(page);
    await waitForRuntimeSynced(page);
    await waitForRuntimeIdle(page);
    await waitForText(page, "#home-profile-summary", "Ada Lovelace");

    const reload = await collectBrowserLoadSummary(page, "reload");
    logBrowserLoadSummary(reload);
    logChurnMetric("reload", reload.churn);

    const c = reload.churn;
    // Read-mostly reload: re-commits stay bounded rather than scaling into a
    // storm. Resuming reads confirmed-loaded state before re-deriving — owned
    // cells are pre-synced, each node's plan is synced under its narrowed read
    // schema and the server's query walk follows links from there as far as
    // the declaration goes, the manifest probe no longer reads not-yet-loaded
    // derived cells, and the
    // list builtins defer their reconcile until the durable container lands
    // instead of overwriting it with [].
    //
    // The conflict bound is ONE, not zero: under the v2 scheduler (which
    // commits first runs instead of running them inside populate's aborted
    // transactions) the profile picker's row map follows field-level alias
    // chains into the profile-home piece's document graph on its first
    // post-reload run. That read set is only knowable by running the row, so
    // one hop is cold (seq-0 basis) and the commit conflicts once — self-healing
    // on the immediate retry, and the rewrite is value-identical. Bounded
    // pre-loading cannot close this without reintroducing populate (spec §15
    // decision 17), so the single residual conflict is accepted and pinned.
    //
    // The revert and schedule-run-error are COUPLED to that conflict rather
    // than given their own flat allowance: the accepted residual is one
    // conflict that produces exactly one revert and one re-run, so those must
    // not exceed the conflict count. This keeps the residual green while still
    // catching a regression that introduces an UNRELATED revert or run-error
    // (which would not be accompanied by a matching second conflict) — a flat
    // <= 1 on all three would have let one such unrelated event hide. Re-tighten
    // the conflict bound to zero if the row-scoped read set ever becomes
    // pre-syncable. The durability test below is the precise correctness gate.
    expect(c.commitConflicts).toBeLessThanOrEqual(1);
    expect(c.commitReverts).toBeLessThanOrEqual(c.commitConflicts);
    expect(c.scheduleRunErrors).toBeLessThanOrEqual(c.commitConflicts);
  });

  it("a profile created in the post-reload window is durable", async () => {
    const page = shell.page();
    const id = await Identity.generate({ implementation: "noble" });

    await gotoHome(shell, id);
    await createProfile(page, "Grace Hopper");
    await waitForRuntimeIdle(page);
    await waitForText(page, "#home-profile-summary", "Grace Hopper");
    await waitForRuntimeSynced(page);

    await gotoHome(shell, id);
    await waitForText(page, "#home-profile-summary", "Grace Hopper");
    // Create immediately after reload, settling only on idle — within the
    // post-reload rehydration window.
    await createProfileRacy(page, "Katherine Johnson");
    await waitForRuntimeSynced(page);

    // Final clean reload renders from durable state. Both must survive.
    await gotoHome(shell, id);
    await waitForRuntimeIdle(page);
    await waitForRuntimeSynced(page);
    await waitForText(page, "#home-profile-summary", "Grace Hopper");
    await waitForText(page, "#home-profile-summary", "Katherine Johnson");
  });
});
