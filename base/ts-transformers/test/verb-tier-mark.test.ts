/**
 * Verb listing marks, producer 1 (verb contract WS-F): `VerbTierMarkTransformer`
 * stamps `tier: "wrapper"` onto result-schema stream properties whose handler
 * binds session-scoped state AND takes a void event. The second conjunct is the
 * measured narrowing recorded in current-behavior §12.1: without it the
 * inference marks `topics.addTopic` — a headless verb that merely CLEARS a
 * session composer draft after a create.
 *
 * Sources compile against the real commonfabric surface, through the full
 * pipeline, and the assertions read the emitted result-schema literal — the
 * artifact `cf piece verbs` will consult.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

async function emit(source: string): Promise<string> {
  return await transformSource(source, { types: COMMONFABRIC_TYPES });
}

/** The marked/unmarked state of one result-schema property in the output. */
function tierMarked(output: string, property: string): boolean {
  // The result-schema literal renders the property as `<name>: { ... }`;
  // a marked one carries `tier: "wrapper"` inside that literal. Slice from
  // the property name to the next property at the same indentation.
  const start = output.indexOf(`${property}: {`);
  if (start < 0) throw new Error(`property ${property} not found in output`);
  const slice = output.slice(start, start + 400);
  return slice.includes('tier: "wrapper"');
}

Deno.test("a void-event action over a session cell is wrapper-tier", async () => {
  const output = await emit(`
    import { action, pattern, type PerSession, Stream, type Writable } from "commonfabric";
    interface Out {
      draft: PerSession<Writable<string>>;
      openComposer: Stream<void>;
    }
    export default pattern<Record<string, never>, Out>(() => {
      const draft = new Writable("");
      const openComposer = action(() => {
        draft.set("");
      });
      return { draft, openComposer };
    });
  `);
  assertEquals(tierMarked(output, "openComposer"), true);
  assertStringIncludes(output, 'tier: "wrapper"');
});

Deno.test("a quoted wrapper verb name is marked like a bare one", async () => {
  // Two things at once, both previously untested: the returned property is a
  // STRING-LITERAL name (the inference and mutation passes must agree on
  // static names), and the wrapper is a directly-authored `handler(...)`
  // whose sessionness lives in the APPLICATION binding (signal 2), not in a
  // lowered action's bound-state schema (signal 1).
  const output = await emit(`
    import { handler, pattern, type PerSession, Stream, type Writable } from "commonfabric";
    interface Out {
      draft: PerSession<Writable<string>>;
      "open-composer": Stream<void>;
    }
    export default pattern<Record<string, never>, Out>(() => {
      const draft = new Writable("");
      const openComposer = handler<void, { draft: Writable<string> }>(
        (_event, state) => {
          state.draft.set("");
        },
      );
      return { draft, "open-composer": openComposer({ draft }) };
    });
  `);
  assertEquals(tierMarked(output, '"open-composer"'), true);
});

Deno.test("a payload-carrying verb touching a session cell stays unmarked", async () => {
  // The addTopic shape: real event payload, incidental session-draft clear.
  const output = await emit(`
    import { action, pattern, type PerSession, Stream, type Writable } from "commonfabric";
    interface CreateEvent { title: string; }
    interface Out {
      titles: string[];
      draft: PerSession<Writable<string>>;
      create: Stream<CreateEvent>;
    }
    export default pattern<Record<string, never>, Out>(() => {
      const titles = new Writable<string[]>([]);
      const draft = new Writable("");
      const create = action((event: CreateEvent) => {
        titles.push(event.title);
        draft.set("");
      });
      return { titles, draft, create };
    });
  `);
  assertEquals(tierMarked(output, "create"), false);
});

Deno.test("a headless verb without session bindings stays unmarked", async () => {
  const output = await emit(`
    import { action, pattern, Stream, type Writable } from "commonfabric";
    interface AddEvent { value: number; }
    interface Out {
      total: number;
      add: Stream<AddEvent>;
    }
    export default pattern<Record<string, never>, Out>(() => {
      const total = new Writable(0);
      const add = action((event: AddEvent) => {
        total.set(total.get() + event.value);
      });
      return { total, add };
    });
  `);
  assertEquals(tierMarked(output, "add"), false);
  assertEquals(output.includes('tier: "wrapper"'), false);
});
