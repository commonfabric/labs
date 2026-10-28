/**
 * Pins the round-trip spelling at the dispatch gate through the whole path
 * `cf piece call` takes: a COMPILED, RUN pattern driven through
 * `executePieceCallable`, so what is asserted is the schema the transformer
 * emits and the runner stores, not what this file assumed. The address a read
 * emits (`/of:…`), standing where the declared contract puts a reference,
 * dispatches as a reference, and a string that is no address or an inline copy
 * is refused naming the position (#5560). The gate's two pure layers,
 * `resolveEmittedAddressArguments` and `handlerVerbEvents`, are pinned in
 * `packages/piece/test/verb-emitted-address.test.ts`.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { createLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { VerbInputValidationError } from "../lib/callable.ts";
import { executePieceCallable } from "../lib/piece.ts";

describe("verb-emitted-address", () => {
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
