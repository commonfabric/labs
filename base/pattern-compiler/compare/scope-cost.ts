/**
 * Measures what each further principal costs an instance that has state
 * of the scope `user`, on the executor of `../exec/` with its documents
 * in memory: `fixtures/scoped-rows.tsx`, a `map` over an array of plain
 * values in place, a list of the space, whose body reads what the acting
 * user picked.
 *
 * `deno run -A --no-check base/pattern-compiler/compare/scope-cost.ts [rows] [users]`
 *
 * Each of `rows` and `users` is a list of sizes separated by commas. For
 * each pair the run prints one line of JSON per step, with the time, the
 * evaluations and the entries of a scope key brought up to date because
 * nothing else demands them (`scopedPulls`) of the step summed over the
 * principals, and the scope instances the store holds after it, with their
 * size as JSON:
 *
 * - `start`: the instance is derived once for each principal.
 * - `again`: it is derived once more for each, with nothing changed.
 * - `post`: one principal appends a note, and the instance is derived for
 *   each principal.
 * - `pick`: one principal picks a note, which changes its own state, and
 *   the instance is derived for each principal.
 */
import { type Artifact, Instance } from "../exec/executor.ts";
import type { Scope } from "../exec/scope-instances.ts";

const [rowSizes = "10,100,1000", userCounts = "1,2,4,8"] = Deno.args;

const [{ patterns }] = JSON.parse(
  await Deno.readTextFile(
    new URL("./fixtures/scoped-rows.emit.json", import.meta.url),
  ),
) as { patterns: (Artifact & { name: string })[] }[];
const artifact = patterns.find(({ name }) => name === "default")!;

for (const rows of rowSizes.split(",").map(Number)) {
  for (const users of userCounts.split(",").map(Number)) {
    let acting = "user-0";
    const instance = new Instance(
      artifact,
      { notes: { $link: { doc: "notes", path: [] } } },
      {
        documents: [{
          id: "notes",
          kind: "notes",
          value: Array.from({ length: rows }, (_, at) => ({ text: `n${at}` })),
        }],
        scopes: {
          keyOf: (scope: Scope) =>
            scope === "user" ? `user:${acting}` : `session:${acting}:s`,
        },
      },
    );
    const stream = (name: string) =>
      instance.streams().find(({ path }) => path.join("/") === name)!.binding;
    /** The scope instances the store holds, and their size as JSON. */
    const scopeInstances = () => {
      const held = [...instance.store.docs].filter(([, { kind }]) =>
        kind === "scope instance"
      );
      return {
        scopeInstances: held.length,
        scopeInstanceBytes: held.reduce(
          (sum, [, { value }]) => sum + (JSON.stringify(value) ?? "").length,
          0,
        ),
      };
    };
    /** Derives for each principal, and prints what that took. */
    const step = (name: string, before?: () => void) => {
      const evaluations = instance.counts.evaluations;
      const elements = instance.counts.elementEvaluations;
      const assemblies = instance.counts.assemblies;
      const pulls = instance.counts.scopedPulls;
      const began = performance.now();
      before?.();
      for (let user = 0; user < users; user++) {
        acting = `user-${user}`;
        instance.settle();
      }
      console.log(JSON.stringify({
        rows,
        users,
        step: name,
        ms: Math.round((performance.now() - began) * 100) / 100,
        evaluations: instance.counts.evaluations - evaluations,
        elementEvaluations: instance.counts.elementEvaluations - elements,
        assemblies: instance.counts.assemblies - assemblies,
        scopedPulls: instance.counts.scopedPulls - pulls,
        setAside: instance.store.scopes?.asideCount ?? 0,
        documents: instance.store.docs.size,
        ...scopeInstances(),
      }));
    };
    step("start");
    step("again");
    step("post", () => {
      acting = "user-0";
      instance.send(stream("post"), { text: "posted" });
    });
    step("pick", () => {
      acting = "user-0";
      instance.send(stream("pick"), { text: "n1" });
    });
  }
}
