// @tripwire:one-post-test-job
//
// Every job in `deno.yml` that runs tests ships its own test records, so a
// check reading the whole run's records has to wait for all of them and
// download what each shipped. Two such checks exist, each with a list of
// those jobs to keep: `Coverage Check` reads their coverage, and
// `Test Topology Store Check` reads their records.
//
// The lane design replaces that matrix with a run whose records are shipped
// once. When that lands, both checks can read one artifact from one place,
// and the reason they are separate jobs with dependency lists of their own
// goes away. `tasks/check-tripwires.ts` carries the obligation that they be
// merged into the single post-test job at that point; this test is the
// assertion that tripwire duplicates.

import { assert } from "@std/assert";
import { shippingJobs } from "./check-tripwires.ts";

Deno.test("more than one job ships the run's test records", async () => {
  // While this holds, a check over the whole run's records cannot be a step
  // of the job that produced them, so the post-test checks stand apart. When
  // it stops holding, the tripwire in `tasks/check-tripwires.ts` says what is
  // owed.
  const shippers = await shippingJobs();
  assert(
    shippers.length > 1,
    `${shippers.length} job(s) ship test records. If the lane switch has ` +
      "landed, the post-test checks are owed a merge into one job: see the " +
      "one-post-test-job tripwire in tasks/check-tripwires.ts",
  );
});
