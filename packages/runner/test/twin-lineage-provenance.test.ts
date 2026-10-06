import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { getVerifiedProvenance } from "../src/harness/verified-provenance.ts";
import type { Module, Pattern } from "../src/builder/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

/**
 * Twin-lineage provenance regression (the "helper is not a function" /
 * helper-unlink family — see the investigation record topic on topics-dev,
 * 2026-07).
 *
 * The failing wild topology: a program carries BOTH an evaluated module
 * lineage and a never-imported-at-runtime "ghost" lineage (dragged in by a
 * type-only import) whose computed-lambda source text is byte-identical to
 * the evaluated one's, plus sub-patterns instantiated per list element. In
 * the wild this combination lost action provenance in long-lived workers:
 * generic action ids at creation, module nodes serialized body-only with no
 * `$implRef`, and silent bare-SES re-evaluation on reload — where every
 * module-scope helper reference breaks.
 *
 * These tests pin the invariants that make that failure impossible to
 * reintroduce quietly:
 *  1. every javascript module node in the compiled twin program carries
 *     object-keyed verified provenance, and
 *  2. every one of them serializes ref-carrying (never body-only), and
 *  3. the program runs healthy end-to-end including the dynamic list-op
 *     (.map row) path with the UI pulled — the surface prior headless
 *     probes never exercised.
 *
 * The ghost here differs from the entry by ONE comment line (and its card
 * import), the sharpest variant from the investigation's factorial: module
 * identities differ while every lambda's source text is byte-identical.
 */

const signer = await Identity.fromPassphrase("twin-lineage-provenance");
const space = signer.did();

//
// The twin topology, inlined (mirrors the investigation's twin3e probe)
//

const ENTRY_BODY = `
import {
  computed,
  Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import TwinCard from "./twin-card.tsx";
import TwinRow from "./twin-row.tsx";

export interface JoinEvent {
  name?: string;
}

// Module-scope arrow helpers — byte-identical across entry and ghost.
const shout = (s: string | undefined) => \`\${s ?? ""}\`.toUpperCase() + "!";
const countNonEmpty = (xs: readonly string[]) =>
  xs.filter((x) => x.trim() !== "").length;

interface MainInput {
  title?: Writable<string | Default<"twin probe">>;
  myName?: Writable<string | Default<"">>;
  joinName?: Writable<string | Default<"">>;
  items?: Writable<string[] | Default<["alpha", "beta"]>>;
}

interface MainOutput {
  [NAME]: string;
  [UI]: VNode;
  loud: string;
  itemCount: number;
  me: string;
  isJoined: boolean;
}

export default pattern<MainInput, MainOutput>(
  ({ title, myName, joinName, items }) => {
    const loud = computed(() => shout(title.get()));
    const itemCount = computed(() => countNonEmpty(items.get()));
    const card = TwinCard({ myName, joinName });
    return {
      [NAME]: "TwinMain",
      [UI]: (
        <div>
          <h3>{loud}</h3>
          <p>items: {itemCount}</p>
          {card[UI]}
          <ul>{items.map((label) => <TwinRow label={label} />)}</ul>
        </div>
      ),
      loud,
      itemCount,
      me: card.me,
      isJoined: card.isJoined,
    };
  },
);
`;

// The ghost: byte-identical to the entry except its card import line and one
// extra comment — module identity differs, every lambda text coincides.
const GHOST_BODY = ENTRY_BODY.replace(
  `import TwinCard from "./twin-card.tsx";`,
  `import TwinCard from "./twin-card-ghost.tsx";`,
).replace(
  "// Module-scope arrow helpers — byte-identical across entry and ghost.",
  "// Module-scope arrow helpers — byte-identical across entry and ghost.\n// (ghost lineage copy)",
);

const CARD_BODY = (ghostSuffix: string) => `
import {
  computed,
  Default,
  handler,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import type { JoinEvent } from "./twin-ghost.tsx";
${ghostSuffix}
// Module-scope arrow helper — byte-identical across both cards.
const trimmedName = (n: string | undefined) => (n ?? "").trim();

// Module-scope handler (the factorial's proven topology): registers via the
// transformer's __cfReg hoist under the module's identity.
const joinAs = handler<JoinEvent, { myName: Writable<string>; joinName: Writable<string> }>(
  (event, { myName, joinName }) => {
    const trimmed = (event.name ?? joinName.get() ?? "").trim();
    if (trimmed !== "") myName.set(trimmed);
  },
);

interface CardInput {
  myName?: Writable<string | Default<"">>;
  joinName?: Writable<string | Default<"">>;
}

interface CardOutput {
  [NAME]: string;
  [UI]: VNode;
  me: string;
  isJoined: boolean;
}

export default pattern<CardInput, CardOutput>(({ myName, joinName }) => {
  const me = computed(() => trimmedName(myName.get()));
  const isJoined = computed(() => trimmedName(myName.get()) !== "");
  return {
    [NAME]: "TwinCard",
    [UI]: (
      <div>
        <input value={joinName} placeholder="Your name..." />
        <button onClick={joinAs({ myName, joinName })}>Join</button>
      </div>
    ),
    me,
    isJoined,
  };
});
`;

const ROW_BODY = `
import {
  computed,
  Default,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

// Module-scope arrow helper — the per-row derive the wild failures hit.
const decorate = (s: string | undefined) => \`• \${(s ?? "").trim()} •\`;

interface RowInput {
  label: Writable<string | Default<"">>;
}

interface RowOutput {
  [NAME]: string;
  [UI]: VNode;
  pretty: string;
}

export default pattern<RowInput, RowOutput>(({ label }) => {
  const pretty = computed(() => decorate(label.get()));
  return {
    [NAME]: "TwinRow",
    [UI]: <li>{pretty}</li>,
    pretty,
  };
});
`;

const TWIN_PROGRAM = {
  main: "/twin-main.tsx",
  files: [
    { name: "/twin-main.tsx", contents: ENTRY_BODY },
    { name: "/twin-ghost.tsx", contents: GHOST_BODY },
    { name: "/twin-card.tsx", contents: CARD_BODY("") },
    { name: "/twin-card-ghost.tsx", contents: CARD_BODY("// (ghost card)\n") },
    { name: "/twin-row.tsx", contents: ROW_BODY },
  ],
};

// Recursively collect every javascript module node, descending into
// sub-pattern module implementations.
function collectJavaScriptModules(
  pattern: Pattern,
  out: Module[] = [],
  depth = 0,
): Module[] {
  if (depth > 3 || !pattern?.nodes) return out;
  for (const node of pattern.nodes) {
    const module = node.module as Module;
    if (!module || typeof module !== "object") continue;
    if (module.type === "pattern") {
      const inner = (module as { implementation?: unknown }).implementation;
      if (inner && typeof inner === "object") {
        collectJavaScriptModules(inner as Pattern, out, depth + 1);
      }
      continue;
    }
    if (module.type === "javascript") out.push(module);
  }
  return out;
}

describe("twin-lineage provenance (helper-unlink regression)", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;
  let tx: IExtendedStorageTransaction | undefined;

  afterEach(async () => {
    await tx?.commit().settled;
    await runtime?.dispose();
    await storageManager?.close();
    tx = undefined;
    runtime = undefined;
    storageManager = undefined;
  });

  const setup = async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    const compiled = await runtime.patternManager.compilePattern(TWIN_PROGRAM);
    await runtime.idle();
    return compiled as Pattern;
  };

  it("every module node keeps provenance and serializes ref-carrying despite the byte-identical ghost lineage", async () => {
    const compiled = await setup();
    const modules = collectJavaScriptModules(compiled);
    // Entry lifts + card lifts/handler ride the compiled graph; the exact
    // count is allowed to evolve, but an empty walk means the collector broke.
    expect(modules.length).toBeGreaterThanOrEqual(6);

    for (const module of modules) {
      const impl = (module as { implementation?: unknown }).implementation;
      expect(typeof impl).toBe("function");
      // Object-keyed verified provenance survived compilation with the ghost
      // lineage present.
      expect(getVerifiedProvenance(impl)).toBeDefined();

      // And the wire shape is ref-carrying — never the silent body-only form
      // that bare-SES re-evaluates outside module scope on reload.
      const json =
        (module as Module & { toEncodableForm?: () => unknown }).toEncodableForm
          ? (module as Module & { toEncodableForm: () => unknown })
            .toEncodableForm() as Record<
              string,
              unknown
            >
          : JSON.parse(JSON.stringify(module));
      expect(json.$implRef).toBeDefined();
      expect(typeof json.implementation).not.toBe("string");
    }
  });

  it("runs healthy end-to-end with the dynamic .map row path materialized", async () => {
    const compiled = await setup();
    tx = runtime!.edit();
    const resultCell = runtime!.getCell<Record<string, unknown>>(
      space,
      "twin-lineage run",
      undefined,
      tx,
    );
    const result = runtime!.run(tx, compiled, {}, resultCell);
    await tx.commit().settled;
    tx = runtime!.edit();

    await result.pull();
    const value = result.getAsQueryResult() as Record<string, unknown>;
    // The module-scope helpers executed in module scope: the derives computed.
    expect(value.loud).toBe("TWIN PROBE!");
    expect(value.itemCount).toBe(2);

    // Pull the UI so the list-op instantiates the per-row sub-patterns — the
    // dynamic path the wild failures fired on (and the one headless probes
    // historically skipped).
    const ui = result.key("$UI");
    await ui.pull();
    expect(ui.getAsQueryResult()).toBeDefined();
  });
});
