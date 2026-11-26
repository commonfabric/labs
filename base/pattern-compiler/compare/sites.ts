/**
 * Estimates what the plans of a set of modules would hold if each
 * pattern that is compiled in were written once and named by its call
 * sites (provisional decision P18; `plan-and-label-templates.md` §1.1,
 * `Callee` and `CallSite`), from the plans that the crate emits, in
 * which such a pattern is written out at every call site.
 *
 * `deno run -A base/pattern-compiler/compare/sites.ts [files of emit output]`
 *
 * With no file it measures the corpus. The crate does not emit the
 * records of P18, so nothing here is a measurement of them: it is a
 * count over the written-out form. A copy is the records of a plan
 * whose `within` ends in the same chain of `site` steps: the cones,
 * with their outputs and the slots that no cone outside the copy
 * lists, and the bodies, collections, state cells, operations, children
 * and bindings. Two copies are taken to be of one callee where their
 * cones are written at the same places of the source. The estimate
 * keeps the largest copy of each callee, and adds `SITE_BYTES` for
 * each call that is written in the body of the pattern or of a callee,
 * as the bytes of a call-site record.
 */
import { fromFileUrl } from "@std/path";

/** The bytes taken for one call-site record. */
export const SITE_BYTES = 200;

type Within = { element?: number; site?: unknown }[];
type Record_ = { within?: Within; at?: { file: string; start: number } };
type Plan = Record<string, unknown> & {
  cones: (Record_ & { slots: number[] })[];
  outputs: { cone: number }[];
  edges?: { to: number }[];
  slots: unknown[];
};

const bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value) ?? "").length;

/** The chain of a record: its `within` up to the last `site` step. */
const chainOf = (within: Within | undefined): string => {
  const steps = within ?? [];
  const last = steps.findLastIndex((step) => step.site !== undefined);
  return last < 0 ? "" : JSON.stringify(steps.slice(0, last + 1));
};

/** What one plan holds, and the estimate. */
export type Sites = {
  plan: number;
  /** The copies, and the callees they are of. */
  copies: number;
  callees: number;
  /** The bytes of all copies, and of the largest copy of each callee. */
  copied: number;
  once: number;
  /** The callees whose copies do not all have the same number of bytes. */
  uneven: number;
  estimate: number;
};

export const sitesOf = (plan: Plan): Sites => {
  const copies = new Map<string, { bytes: number; places: string[] }>();
  const copy = (chain: string) => {
    let held = copies.get(chain);
    if (held === undefined) {
      held = { bytes: 0, places: [] };
      copies.set(chain, held);
    }
    return held;
  };
  // The cones of each slot, to give a slot to the one copy that reads it.
  const readers = new Map<number, Set<string>>();
  plan.cones.forEach((cone) => {
    const chain = chainOf(cone.within);
    for (const slot of cone.slots) {
      const chains = readers.get(slot) ?? new Set();
      chains.add(chain);
      readers.set(slot, chains);
    }
    if (chain === "") return;
    const held = copy(chain);
    held.bytes += bytes(cone);
    held.places.push(`${cone.at?.file}:${cone.at?.start}`);
  });
  for (const edge of plan.edges ?? []) {
    const chain = chainOf(plan.cones[edge.to]?.within);
    if (chain !== "") copy(chain).bytes += bytes(edge);
  }
  for (const output of plan.outputs) {
    const chain = chainOf(plan.cones[output.cone]?.within);
    if (chain !== "") copy(chain).bytes += bytes(output);
  }
  plan.slots.forEach((slot, index) => {
    const chains = readers.get(index);
    if (chains?.size !== 1) return;
    const [chain] = chains;
    if (chain !== "") copy(chain).bytes += bytes(slot);
  });
  for (
    const list of [
      "bodies",
      "collections",
      "stateCells",
      "operations",
      "children",
      "bindings",
    ]
  ) {
    for (const record of (plan[list] ?? []) as Record_[]) {
      const chain = chainOf(record.within);
      if (chain !== "") copy(chain).bytes += bytes(record);
    }
  }
  // The calls that are written in the body of each copy, and in the
  // body of the pattern itself: the chains that are one `site` step
  // longer.
  const calls = new Map<string, number>();
  for (const chain of copies.keys()) {
    const steps = JSON.parse(chain) as Within;
    const above = chainOf(steps.slice(0, -1));
    calls.set(above, (calls.get(above) ?? 0) + 1);
  }
  const callees = new Map<string, { sizes: number[]; calls: number }>();
  for (const [chain, { bytes, places }] of copies) {
    const id = JSON.stringify([...places].sort());
    const held = callees.get(id) ?? { sizes: [], calls: 0 };
    held.sizes.push(bytes);
    held.calls = Math.max(held.calls, calls.get(chain) ?? 0);
    callees.set(id, held);
  }
  let copied = 0;
  let once = 0;
  let uneven = 0;
  // A call-site record for each call that is written in the body of
  // the pattern or in the body of a callee, once.
  let sites = calls.get("") ?? 0;
  for (const { sizes, calls } of callees.values()) {
    copied += sizes.reduce((sum, size) => sum + size, 0);
    once += sizes.reduce((most, size) => Math.max(most, size), 0);
    sites += calls;
    if (new Set(sizes).size > 1) uneven += 1;
  }
  const whole = bytes(plan);
  return {
    plan: whole,
    copies: copies.size,
    callees: callees.size,
    copied,
    once,
    uneven,
    estimate: whole - copied + once + sites * SITE_BYTES,
  };
};

if (import.meta.main) {
  const repository = fromFileUrl(new URL("../../../", import.meta.url));
  type Emitted = { module: string; patterns: { name?: string; plan: Plan }[] };
  let modules: Emitted[] = [];
  if (Deno.args.length === 0) {
    const listed = await new Deno.Command(
      fromFileUrl(
        new URL("../target/release/pattern-compiler", import.meta.url),
      ),
      { args: ["emit", "--corpus", "."], cwd: `${repository}patterns` },
    ).output();
    modules = new TextDecoder().decode(listed.stdout).split("\n").filter((
      line,
    ) => line.length > 0).map((line) => JSON.parse(line));
  } else {
    for (const file of Deno.args) {
      for (const module of JSON.parse(await Deno.readTextFile(file))) {
        modules.push(module);
      }
    }
  }
  const total = {
    plan: 0,
    copies: 0,
    callees: 0,
    copied: 0,
    once: 0,
    uneven: 0,
    estimate: 0,
  };
  const rows: (Sites & { name: string })[] = [];
  for (const { module, patterns } of modules) {
    for (const { name, plan } of patterns) {
      const sites = sitesOf(plan);
      for (const member of Object.keys(total) as (keyof Sites)[]) {
        total[member] += sites[member];
      }
      rows.push({ name: `${module}#${name}`, ...sites });
    }
  }
  rows.sort((a, b) => (b.plan - b.estimate) - (a.plan - a.estimate));
  for (const row of rows.slice(0, Deno.args.length === 0 ? 12 : rows.length)) {
    console.log(JSON.stringify(row));
  }
  console.log(JSON.stringify({ name: "in all", plans: rows.length, ...total }));
}
