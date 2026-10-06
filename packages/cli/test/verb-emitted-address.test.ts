/**
 * Pins the round-trip spelling at the dispatch gate: the address a read emits
 * (`/of:…`), standing where the DECLARED contract puts a reference, converts
 * to the link envelope dispatch already accepts — and the two payloads that
 * could only ever be mistakes at such a position are refused naming it: a
 * string that is no address, and an inline copy that would store a detached
 * document (#5560).
 *
 * The three layers are pinned separately because each can fail alone:
 * `resolveEmittedAddressArguments` decides positions and spellings,
 * `handlerVerbEvents` recovers the contract the decision reads — the handler
 * module in the compiled pattern, the only serialized surface where a
 * reference marker survives link sanitization — and the live half drives a
 * COMPILED, RUN pattern through `executePieceCallable`, so what is asserted
 * is the schema the transformer emits and the runner stores, not what this
 * file assumed.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { type JSONSchema, Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  resolveEmittedAddressArguments,
  VerbInputValidationError,
} from "../lib/callable.ts";
import { executePieceCallable, handlerVerbEvents } from "../lib/piece.ts";

/** A real-shaped piece id, so the address parser judges the spelling and not
 * a malformed hash. */
const ID = "of:fid1:d2cuq3cMqJY3oaG3fkalMq4uO7BgLfBFkvI-Dm-Kk94";

const ADDRESS = `/${ID}`;
const ENVELOPE = { "/": { "link@1": { id: ID } } };

describe("verb-emitted-address", () => {
  describe("resolveEmittedAddressArguments()", () => {
    /** A contract whose one field is a declared reference, marker inline. */
    const inlineMarker: JSONSchema = {
      type: "object",
      properties: {
        on: { type: "object", asCell: ["cell"] },
      },
    };

    it("converts an address string at a reference position into the link envelope", () => {
      expect(resolveEmittedAddressArguments({ on: ADDRESS }, inlineMarker))
        .toEqual({ value: { on: ENVELOPE } });
    });

    it("converts the `$link` object a marked read renders, alone or beside projected contents", () => {
      // A read renders a marked position as `{"$link": "/of:…"}`, and joins
      // the contents it also projected into the same object. Either way the
      // address is what the position takes; the contents are the target's
      // own fields, which a reference never stores.

      expect(
        resolveEmittedAddressArguments(
          { on: { $link: ADDRESS } },
          inlineMarker,
        ),
      ).toEqual({ value: { on: ENVELOPE } });
      expect(
        resolveEmittedAddressArguments(
          { on: { $link: ADDRESS, title: "First note" } },
          inlineMarker,
        ),
      ).toEqual({ value: { on: ENVELOPE } });
      const listed: JSONSchema = {
        type: "object",
        properties: {
          them: { type: "array", items: { type: "object", asCell: ["cell"] } },
        },
      };
      expect(
        resolveEmittedAddressArguments(
          { them: [{ $link: ADDRESS }, ADDRESS] },
          listed,
        ),
      ).toEqual({ value: { them: [ENVELOPE, ENVELOPE] } });
    });

    it("judges the string inside `$link` as it judges a bare one", () => {
      expect(
        resolveEmittedAddressArguments(
          { on: { $link: "/tracker" } },
          inlineMarker,
        )
          .refusal,
      ).toContain('"/tracker" at <event>.on is not an address');
    });

    it("refuses a `$link` that holds no string as an inline copy", () => {
      // `{"$link": true}` is the projection-schema marker, not an address.

      expect(
        resolveEmittedAddressArguments({ on: { $link: true } }, inlineMarker)
          .refusal,
      ).toContain("an inline copy would store a detached document");
    });

    it("refuses a reference naming a piece by slug or a space by name", () => {
      // The wider vocabulary `cf`'s own intake takes stops at this seam. What
      // is built here is a stored link, which holds the id and the space
      // verbatim and has no session behind it to resolve a name with, so a
      // slug written into one is a durable edge pointing at nothing.
      expect(
        resolveEmittedAddressArguments({ on: "/tracker" }, inlineMarker)
          .refusal,
      ).toBe(
        '"/tracker" at <event>.on is not an address — the position ' +
          "declares a reference, and takes the /of:… form a read prints",
      );
      expect(
        resolveEmittedAddressArguments({ on: `/@my-space/${ID}` }, inlineMarker)
          .refusal,
      ).toContain("is not an address");
      // The colon is what separates the vocabularies, not the length: a slug
      // may run to eighty characters, so one past twenty reads as a handle to
      // a length rule and is stored verbatim.
      expect(
        resolveEmittedAddressArguments(
          { on: "/a-piece-name-that-is-twenty-plus" },
          inlineMarker,
        ).refusal,
      ).toContain("is not an address");
    });

    it("converts a reference whose space is a DID, which a link can hold", () => {
      const did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
      expect(
        resolveEmittedAddressArguments({ on: `/@${did}/${ID}` }, inlineMarker),
      ).toEqual({
        value: { on: { "/": { "link@1": { id: ID, space: did } } } },
      });
    });

    it("reads the marker off the `$ref` site, where the compiled contract carries it", () => {
      // The compiled contract spells a named reference `{$ref: …, asCell: […]}`
      // — the marker rides the REFERENCE SITE. A walk that resolves the `$ref`
      // before looking loses it and converts nothing, which is exactly how the
      // first live probe of this feature failed.

      const schema: JSONSchema = {
        type: "object",
        properties: { on: { $ref: "#/$defs/Item", asCell: ["cell"] } },
        $defs: { Item: { type: "object", properties: {} } },
      };
      expect(resolveEmittedAddressArguments({ on: ADDRESS }, schema))
        .toEqual({ value: { on: ENVELOPE } });
    });

    it("reads the marker off the `$ref` target as well", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { on: { $ref: "#/$defs/Item" } },
        $defs: { Item: { type: "object", asCell: ["cell"] } },
      };
      expect(resolveEmittedAddressArguments({ on: ADDRESS }, schema))
        .toEqual({ value: { on: ENVELOPE } });
    });

    it("carries the address's path into the envelope", () => {
      expect(
        resolveEmittedAddressArguments(
          { on: `${ADDRESS}/status` },
          inlineMarker,
        ),
      ).toEqual({
        value: { on: { "/": { "link@1": { id: ID, path: ["status"] } } } },
      });
    });

    it("refuses a string that is not an address, naming the position and the form", () => {
      const resolved = resolveEmittedAddressArguments(
        { on: "not-an-address" },
        inlineMarker,
      );
      expect(resolved.refusal).toBe(
        '"not-an-address" at <event>.on is not an address — the position ' +
          "declares a reference, and takes the /of:… form a read prints",
      );
    });

    it("refuses the `#argument` suffix at a reference position", () => {
      // `#argument` names a piece's arguments cell for commands that take
      // `--input`; as a verb argument it addresses nothing a reference position
      // can hold.

      const resolved = resolveEmittedAddressArguments(
        { on: `${ADDRESS}#argument` },
        inlineMarker,
      );
      expect(resolved.refusal).toContain("is not an address");
    });

    it("refuses a suffix the address grammar rejects outright", () => {
      // The parser THROWS on an unknown suffix rather than declining; the walk
      // absorbs that into the same refusal, so a caller never sees a parser
      // stack where a refusal was owed.

      const resolved = resolveEmittedAddressArguments(
        { on: `${ADDRESS}#bogus` },
        inlineMarker,
      );
      expect(resolved.refusal).toContain("is not an address");
    });

    it("refuses an inline copy at a reference position as a detached document", () => {
      const resolved = resolveEmittedAddressArguments(
        { on: { title: "a copy" } },
        inlineMarker,
      );
      expect(resolved.refusal).toBe(
        "<event>.on declares a reference, and an inline copy would store a " +
          "detached document rather than an edge — send the address a read " +
          "printed",
      );
    });

    it("passes a link envelope through untouched", () => {
      const payload = { on: ENVELOPE };
      expect(resolveEmittedAddressArguments(payload, inlineMarker))
        .toEqual({ value: payload });
    });

    it("leaves a string at an unmarked position for shape validation", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: { on: { type: "object" } },
      };
      const payload = { on: ADDRESS };
      expect(resolveEmittedAddressArguments(payload, schema))
        .toEqual({ value: payload });
    });

    it("never converts at the event root", () => {
      // The event root is where the payload ITSELF sits; a marker there says
      // how the runtime holds the event, not that the caller sends an address.

      const schema: JSONSchema = {
        type: "object",
        asCell: ["cell"],
        properties: { on: { type: "object" } },
      };
      expect(resolveEmittedAddressArguments(ADDRESS, schema))
        .toEqual({ value: ADDRESS });
    });

    it("walks arrays by `items`, and indexes the position a refusal names", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          them: { type: "array", items: { type: "object", asCell: ["cell"] } },
        },
      };
      expect(
        resolveEmittedAddressArguments({ them: [ADDRESS, ADDRESS] }, schema),
      ).toEqual({ value: { them: [ENVELOPE, ENVELOPE] } });
      expect(
        resolveEmittedAddressArguments({ them: [ADDRESS, "nope"] }, schema)
          .refusal,
      ).toContain('"nope" at <event>.them[1] is not an address');
    });

    it("walks `prefixItems` by position, and flows the positions beyond them", () => {
      const schema: JSONSchema = {
        type: "object",
        properties: {
          pair: {
            type: "array",
            prefixItems: [
              { type: "string" },
              { type: "object", asCell: ["cell"] },
            ],
          },
        },
      };
      expect(
        resolveEmittedAddressArguments({ pair: ["label", ADDRESS] }, schema),
      ).toEqual({ value: { pair: ["label", ENVELOPE] } });
      // A third element has no declared position: it flows through as
      // written, address form or not.
      expect(
        resolveEmittedAddressArguments(
          { pair: ["label", ADDRESS, ADDRESS] },
          schema,
        ),
      ).toEqual({ value: { pair: ["label", ENVELOPE, ADDRESS] } });
    });

    it("walks a record schema's values through `additionalProperties`", () => {
      // A record schema names no key at all: its values are declared on
      // `additionalProperties`, which is where a map of references puts its
      // marker. Reading only `properties` skips every one of them.

      const schema: JSONSchema = {
        type: "object",
        additionalProperties: { type: "object", asCell: ["cell"] },
      };
      expect(resolveEmittedAddressArguments({ anything: ADDRESS }, schema))
        .toEqual({ value: { anything: ENVELOPE } });
      expect(
        resolveEmittedAddressArguments({ anything: "nope" }, schema).refusal,
      ).toContain('"nope" at <event>.anything is not an address');
    });

    it("prefers a named property over `additionalProperties`", () => {
      // A named key keeps its own account; `additionalProperties` covers only
      // what `properties` does not name.

      const schema: JSONSchema = {
        type: "object",
        properties: { plain: { type: "string" } },
        additionalProperties: { type: "object", asCell: ["cell"] },
      };
      expect(
        resolveEmittedAddressArguments(
          { plain: ADDRESS, other: ADDRESS },
          schema,
        ),
      ).toEqual({ value: { plain: ADDRESS, other: ENVELOPE } });
    });

    it("walks a conjunction member-wise, refusals included", () => {
      const schema: JSONSchema = {
        allOf: [{
          type: "object",
          properties: { on: { type: "object", asCell: ["cell"] } },
        }],
      };
      expect(resolveEmittedAddressArguments({ on: ADDRESS }, schema))
        .toEqual({ value: { on: ENVELOPE } });
      expect(
        resolveEmittedAddressArguments({ on: "nope" }, schema).refusal,
      ).toContain('"nope" at <event>.on is not an address');
    });

    it("passes over disjunction interiors", () => {
      // Choosing a disjunction branch is the caller's; converting inside one
      // would pick it for them.

      const schema: JSONSchema = {
        type: "object",
        properties: {
          on: {
            anyOf: [{ type: "object", asCell: ["cell"] }, { type: "null" }],
          },
        },
      };
      const payload = { on: ADDRESS };
      expect(resolveEmittedAddressArguments(payload, schema))
        .toEqual({ value: payload });
    });

    it("flows a field the contract does not name through untouched", () => {
      const payload = { on: ADDRESS, extra: ADDRESS };
      const resolved = resolveEmittedAddressArguments(payload, inlineMarker);
      expect((resolved.value as { extra: unknown }).extra).toBe(ADDRESS);
    });

    it("converts nothing without a contract", () => {
      const payload = { on: ADDRESS };
      expect(resolveEmittedAddressArguments(payload, undefined))
        .toEqual({ value: payload });
    });
  });

  describe("handlerVerbEvents()", () => {
    const link = (n: number) => ({
      $alias: { partialCause: { n }, path: ["stream"], scope: "space" },
    });
    const eventDef: JSONSchema = {
      type: "object",
      properties: { on: { $ref: "#/$defs/Item", asCell: ["cell"] } },
    };

    it("resolves a `$ref` event against the module schema's own root", () => {
      const pattern = {
        result: { relate: link(1) },
        nodes: [{
          inputs: { $event: link(1) },
          module: {
            argumentSchema: {
              type: "object",
              properties: { $event: { $ref: "#/$defs/E" }, $ctx: true },
              $defs: { E: eventDef, Item: { type: "object" } },
            },
          },
        }],
      };
      const event = handlerVerbEvents(pattern).get("relate") as
        & JSONSchema
        & object;
      expect(event.properties).toEqual(eventDef.properties);
      // Self-contained: the interior `$ref` must stay resolvable without the
      // pattern in hand.
      expect((event.$defs as Record<string, unknown>).Item).toBeDefined();
    });

    it("attaches the module root's `$defs` to an inline event", () => {
      const pattern = {
        result: { relate: link(1) },
        nodes: [{
          inputs: { $event: link(1) },
          module: {
            argumentSchema: {
              type: "object",
              properties: { $event: eventDef, $ctx: true },
              $defs: { Item: { type: "object" } },
            },
          },
        }],
      };
      const event = handlerVerbEvents(pattern).get("relate") as
        & JSONSchema
        & object;
      expect(event.properties).toEqual(eventDef.properties);
      expect((event.$defs as Record<string, unknown>).Item).toBeDefined();
    });

    it("maps a stream two handler nodes share to `undefined`", () => {
      // A stream two handler nodes share is still a verb, but it names no
      // single contract — matching what its declared result does.

      const argumentSchema = {
        type: "object",
        properties: { $event: eventDef, $ctx: true },
      };
      const pattern = {
        result: { relate: link(1) },
        nodes: [
          { inputs: { $event: link(1) }, module: { argumentSchema } },
          { inputs: { $event: link(1) }, module: { argumentSchema } },
        ],
      };
      const verbs = handlerVerbEvents(pattern);
      expect(verbs.has("relate")).toBe(true);
      expect(verbs.get("relate")).toBeUndefined();
    });

    it("keys a matched node whose module states no schema, as `undefined`", () => {
      const pattern = {
        result: { relate: link(1) },
        nodes: [{ inputs: { $event: link(1) }, module: {} }],
      };
      const verbs = handlerVerbEvents(pattern);
      expect(verbs.has("relate")).toBe(true);
      expect(verbs.get("relate")).toBeUndefined();
    });

    it("omits a result property no handler node drives", () => {
      const pattern = {
        result: { data: link(1) },
        // A node with no inputs at all sits beside the mismatch: the walk
        // steps over what it cannot read rather than crashing on it.
        nodes: [{}, { inputs: { $event: link(2) }, module: {} }],
      };
      expect(handlerVerbEvents(pattern).has("data")).toBe(false);
    });

    it("returns an empty map for a pattern with no result", () => {
      expect(handlerVerbEvents(null).size).toBe(0);
      expect(handlerVerbEvents({}).size).toBe(0);
    });
  });

  describe("dispatch through the compiled contract", () => {
    /**
     * A pattern whose `relate` verb declares a reference — `Writable<>` on the
     * event field is the spelling that compiles to the `asCell` marker the
     * gate reads — beside `note`, a verb of plain data, which is the control:
     * nothing here may touch a payload with no reference positions.
     */
    const PROGRAM = {
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: [
          'import { action, NAME, pattern, type PatternFactory, type Stream, Writable } from "commonfabric";',
          "",
          "interface Recorded { count: number; }",
          "interface RelateEvent { on: Writable<ProbeOutput>; }",
          "interface TagEvent { on: Writable<ProbeOutput>; label: string; }",
          "interface NoteEvent { body: string; }",
          "",
          "export interface ProbeOutput {",
          "  [NAME]: string;",
          "  label: string;",
          "  links: ProbeOutput[];",
          "  notes: string[];",
          "  relate: Stream<RelateEvent, Recorded>;",
          "  tag: Stream<TagEvent, Recorded>;",
          "  note: Stream<NoteEvent, Recorded>;",
          "}",
          "",
          "interface ProbeInput { label?: string; }",
          "",
          "export const Probe: PatternFactory<ProbeInput, ProbeOutput> = pattern<ProbeInput, ProbeOutput>(",
          "  () => {",
          "    const links = new Writable<ProbeOutput[]>([]);",
          "    const notes = new Writable<string[]>([]);",
          "    const relate = action<RelateEvent, Recorded>((event) => {",
          "      const target = event.on;",
          "      if (!target) throw new Error('relate: on must name a piece');",
          "      links.push(target);",
          "      return { count: (links.get() ?? []).length };",
          "    });",
          "    const tag = action<TagEvent, Recorded>((event) => {",
          "      if (!event.on || !event.label) throw new Error('tag: on and label');",
          "      links.push(event.on);",
          "      notes.push(event.label);",
          "      return { count: (links.get() ?? []).length };",
          "    });",
          "    const note = action<NoteEvent, Recorded>((event) => {",
          "      notes.push(event.body);",
          "      return { count: (notes.get() ?? []).length };",
          "    });",
          "    return { [NAME]: 'Probe', label: 'probe-root', links, notes, relate, tag, note };",
          "  },",
          ");",
          "",
          "export default Probe;",
        ].join("\n"),
      }],
    };

    interface Probe {
      /** Dispatch `verb` as `cf piece call` does, `payload` spelled as the
       * one positional JSON argument a caller writes by hand. */
      call: (verb: string, payload: unknown) => Promise<unknown>;

      /** The piece's own address, exactly as a read emits it. */
      address: string;

      /** How many entries `links` holds. */
      linkCount: () => number;

      /** `links[0]` RAW — the sigil link itself where a reference was
       * stored, and the object itself where a copy was. */
      storedRaw: () => unknown;

      /** `links[0]` read THROUGH, so it says where the edge landed. */
      linkedLabel: () => string | undefined;

      notes: () => string[];

      /** How many times the dispatch path loaded the compiled pattern. */
      patternLoads: () => number;
    }

    async function withProbe<T>(
      passphrase: string,
      body: (probe: Probe) => Promise<T>,
      options: { patternUnavailable?: boolean } = {},
    ): Promise<T> {
      const signer = await Identity.fromPassphrase(passphrase);
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
      });
      const space = signer.did();
      try {
        const compiled = await runtime.patternManager.compilePattern(
          PROGRAM as never,
          { space },
        );
        const tx = runtime.edit();
        const rootCell = runtime.getCell(
          space,
          "emitted-address",
          undefined,
          tx,
        );
        const root = runtime.run(tx, compiled, {}, rootCell);
        runtime.prepareTxForCommit(tx);
        expect((await tx.commit().settled).error).toBeUndefined();
        await root.pull();

        let patternLoads = 0;
        const piece = {
          result: { getCell: () => Promise.resolve(root) },
          input: { getCell: () => Promise.resolve(root) },
          getCell: () => root,
          getPattern: () => {
            patternLoads++;
            return options.patternUnavailable
              ? Promise.reject(new Error("pattern unavailable"))
              : Promise.resolve(compiled);
          },
        };
        const deps = {
          loadPieces: () =>
            Promise.resolve({ getSpace: () => space, runtime } as never),
          loadPiece: () => Promise.resolve(piece as never),
        };
        const config = {
          apiUrl: "http://localhost:8000",
          identity: "/tmp/test-identity.pem",
          piece: "fid1:live",
          space,
        };

        let dispatched = 0;
        return await body({
          address: createLLMFriendlyLink(
            root.getAsNormalizedFullLink(),
            space,
          ),
          linkCount: () =>
            ((root.key("links").get() ?? []) as unknown[]).length,
          storedRaw: () => root.key("links").key(0).getRaw(),
          linkedLabel: () => {
            const label: unknown = root.key("links").key(0).key("label").get();
            return typeof label === "string" ? label : undefined;
          },
          notes: () => (root.key("notes").get() ?? []) as unknown as string[],
          patternLoads: () => patternLoads,
          call: async (verb, payload) => {
            dispatched++;
            return await executePieceCallable(
              config,
              verb,
              ["--json", JSON.stringify(payload)],
              {
                ...deps,
                invocation: { id: `inv-${dispatched}`, session: "sess" },
              } as never,
            );
          },
        });
      } finally {
        await runtime.dispose?.();
        await storageManager.close?.();
      }
    }

    it("dispatches the address a read emits as a reference, and the edge lands on the target", async () => {
      await withProbe("emitted-address-converts", async (probe) => {
        await probe.call("relate", { on: probe.address });
        // A sigil link and not a copy: the raw stored element is the link
        // object itself.
        expect(probe.storedRaw()).toHaveProperty("/");
        // And it points where the address pointed: reading through it lands
        // on the root's own field.
        expect(probe.linkedLabel()).toBe("probe-root");
      });
    });

    it("dispatches the `$link` object a read renders as a reference, and the edge lands on the target", async () => {
      await withProbe("emitted-address-rendered-object", async (probe) => {
        await probe.call("relate", { on: { $link: probe.address } });
        expect(probe.storedRaw()).toHaveProperty("/");
        expect(probe.linkedLabel()).toBe("probe-root");
      });
    });

    it("dispatches the `$link` object joined by projected contents as the address alone", async () => {
      // What a marked read that also projected fields prints: the address and
      // the target's contents in one object. The label beside the address is
      // deliberately not the target's, so an edge and a stored copy read
      // differently.

      await withProbe(
        "emitted-address-rendered-object-with-contents",
        async (probe) => {
          await probe.call("relate", {
            on: { $link: probe.address, label: "a projected copy" },
          });
          expect(probe.storedRaw()).toHaveProperty("/");
          expect(probe.linkedLabel()).toBe("probe-root");
        },
      );
    });

    it("refuses a string that is not an address, naming the position", async () => {
      await withProbe("emitted-address-refuses-string", async (probe) => {
        await expect(probe.call("relate", { on: "not-an-address" }))
          .rejects.toThrow(VerbInputValidationError);
        await expect(probe.call("relate", { on: "not-an-address" }))
          .rejects.toThrow(
            '"not-an-address" at <event>.on is not an address',
          );
        expect(probe.linkCount()).toBe(0);
      });
    });

    it("refuses an inline copy as a detached document", async () => {
      await withProbe("emitted-address-refuses-copy", async (probe) => {
        await expect(probe.call("relate", { on: { label: "a copy" } }))
          .rejects.toThrow(
            "<event>.on declares a reference, and an inline copy would " +
              "store a detached document",
          );
        expect(probe.linkCount()).toBe(0);
      });
    });

    it("refuses a copy that satisfies the published shape in full", async () => {
      // #5560 in its sharpest form, and the one the published schema alone
      // cannot catch: a copy carrying every field the target declares, which
      // validates precisely BECAUSE it matches the shape. Refusing the
      // incomplete copy above while accepting this one would leave the
      // corruption exactly where it was found — silent, and shaped like
      // success.

      await withProbe("emitted-address-refuses-full-copy", async (probe) => {
        const complete = {
          "$NAME": "complete",
          label: "a complete copy",
          links: [],
          notes: [],
          relate: { on: { "/": { "link@1": { id: probe.address.slice(1) } } } },
          note: { body: "x" },
        };
        await expect(probe.call("relate", { on: complete }))
          .rejects.toThrow(
            "<event>.on declares a reference, and an inline copy would " +
              "store a detached document",
          );
        expect(probe.linkCount()).toBe(0);
      });
    });

    it("still accepts the hand-assembled link envelope", async () => {
      await withProbe("emitted-address-envelope", async (probe) => {
        const id = probe.address.replace(/^\//, "");
        await probe.call("relate", { on: { "/": { "link@1": { id } } } });
        expect(probe.linkedLabel()).toBe("probe-root");
      });
    });

    it("touches nothing on a verb with no reference positions", async () => {
      await withProbe("emitted-address-plain-verb", async (probe) => {
        await probe.call("note", { body: "plain data" });
        expect(probe.notes()).toEqual(["plain data"]);
      });
    });

    it("loads the pattern only where the contract can change the answer", async () => {
      // The dispatch-cost contract, and the bound on the copy check above.
      // Sanitization strips the reference MARKER and keeps the SHAPE, so a
      // string at a declared reference is refused by the published schema
      // before the gate asks, and only two payloads can have their reading
      // changed by the contract: one the shape refused, and one it accepted
      // carrying an inline object. A flat payload of scalars is neither, and
      // dispatches without loading the compiled pattern.

      await withProbe("emitted-address-load-cost", async (probe) => {
        await probe.call("note", { body: "no load" });
        expect(probe.patternLoads()).toBe(0);
        // An envelope is a reference already, not a copy, so it does not
        // pull the contract either.
        const id = probe.address.slice(1);
        await probe.call("relate", { on: { "/": { "link@1": { id } } } });
        expect(probe.patternLoads()).toBe(0);
        // The address string: refused by the shape, so the contract decides.
        await probe.call("relate", { on: probe.address });
        expect(probe.patternLoads()).toBe(1);
      });
    });

    it("re-judges a converted payload, and reports what still fails", async () => {
      // A conversion repairs one position; it does not vouch for the rest of
      // the payload. What the published shape still refuses after it is the
      // refusal the caller reads — the REMAINING problem, not the solved one.

      await withProbe("emitted-address-rejudge", async (probe) => {
        const failure = await probe.call("tag", { on: probe.address })
          .then(() => undefined, (error: unknown) => String(error));
        expect(failure).toContain("label");
        expect(failure).not.toContain("is not an address");
        expect(probe.linkCount()).toBe(0);
      });
    });

    it("keeps the plain refusal when the pattern will not load", async () => {
      // Degradation, not a crash: a pattern that will not load costs the call
      // its conversion — the plain shape refusal stands — while a payload the
      // published shape accepts still dispatches.

      await withProbe("emitted-address-no-pattern", async (probe) => {
        await expect(probe.call("relate", { on: probe.address }))
          .rejects.toThrow("does not match type object");
        await probe.call("note", { body: "still dispatches" });
        expect(probe.notes()).toEqual(["still dispatches"]);
      }, { patternUnavailable: true });
    });
  });
});
