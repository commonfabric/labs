/// <cts-enable />

/**
 * Each participant of a multi-user test compiles the pattern in its own
 * worker, so an attachment made where the workers are spawned does not reach
 * them. This reads a data file from inside both participants, which is the
 * only place the crossing can be observed.
 */

import { assert, dataFile, multiUserTest, pattern, TESTS } from "commonfabric";

interface Cities {
  cities: string[];
}

function cityCount(): number {
  return (JSON.parse(dataFile("/data/cities.json")) as Cities).cities.length;
}

export const setup = pattern(() => ({ count: cityCount() }));

export const alice = pattern<{ count: number }>(() => {
  const assert_alice_reads_the_data_file = assert(() => cityCount() === 2);
  return { [TESTS]: [{ assertion: assert_alice_reads_the_data_file }] };
});

export const bob = pattern<{ count: number }>(() => {
  const assert_bob_reads_the_data_file = assert(() => cityCount() === 2);
  return { [TESTS]: [{ assertion: assert_bob_reads_the_data_file }] };
});

export default multiUserTest({ setup, participants: { alice, bob } });
