import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { taggedHashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import { isCell } from "../src/cell.ts";
import { DataFileStrings } from "../src/data-file-strings.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import { isPrimitiveCellLink } from "../src/link-types.ts";
import { createSigilLinkFromParsedLink, parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { rendererVDOMSchema } from "../src/schemas.ts";
import { UI } from "../src/shared.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

const signer = await Identity.fromPassphrase("data-file-strings");
const space = signer.did();

/** A data file long enough to be stored by reference. */
const PAGE = `<p>${"glazed ".repeat(300)}</p>`;

/** A data file too short to be stored by reference. */
const NOTE = "a short note";

/**
 * The value the worker reconciler sets on an element for a prop a render read
 * returned: a cell's current value, since the reconciler subscribes to a
 * cell-valued prop, and any other value as it is.
 */
function renderedProp(value: unknown): unknown {
  return isCell(value) ? value.get() : value;
}

/** The id of the code document holding `text`. */
function codeDocumentId(text: string): `cid:${string}` {
  return `cid:${taggedHashStringOf(text)}`;
}

describe("data-file-strings", () => {
  describe("DataFileStrings", () => {
    describe("instance members", () => {
      describe("linkInto()", () => {
        it("replaces a recorded string with a link to its code document", () => {
          const strings = new DataFileStrings();
          strings.record(PAGE);

          const { value, documents } = strings.linkInto({ page: PAGE }, space);

          expect(value).toEqual({
            page: createSigilLinkFromParsedLink({
              id: codeDocumentId(PAGE),
              path: [],
              space,
            }),
          });
          expect(documents).toEqual([PAGE]);
        });

        it("replaces a recorded string inside nested arrays and records", () => {
          const strings = new DataFileStrings();
          strings.record(PAGE);

          const { value } = strings.linkInto(
            { outer: [{ inner: PAGE }, "kept"] },
            space,
          );

          const outer = (value as { outer: [{ inner: unknown }, string] })
            .outer;
          expect(isPrimitiveCellLink(outer[0].inner)).toBe(true);
          expect(outer[1]).toBe("kept");
        });

        it("returns the value itself when nothing in it was recorded", () => {
          const strings = new DataFileStrings();
          strings.record(PAGE);
          const original = { other: "x".repeat(2000), list: [1, 2] };

          const { value, documents } = strings.linkInto(original, space);

          expect(value).toBe(original);
          expect(documents).toEqual([]);
        });

        it("leaves a recorded string shorter than 1,024 characters inline", () => {
          const strings = new DataFileStrings();
          strings.record(NOTE);

          const { value } = strings.linkInto({ note: NOTE }, space);

          expect(value).toEqual({ note: NOTE });
        });

        it("names a string once in `documents` however often it occurs", () => {
          const strings = new DataFileStrings();
          strings.record(PAGE);

          const { documents } = strings.linkInto(
            [PAGE, { again: PAGE }],
            space,
          );

          expect(documents).toEqual([PAGE]);
        });

        it("returns a link as itself", () => {
          const strings = new DataFileStrings();
          strings.record(PAGE);
          const link = createSigilLinkFromParsedLink({
            id: "of:fid1:elsewhere",
            path: [],
            space,
          });

          const { value } = strings.linkInto({ link }, space);

          expect((value as { link: unknown }).link).toBe(link);
        });
      });
    });
  });

  describe("a result projection", () => {
    let storage: ReturnType<typeof EmulatedStorageManager.emulate>;
    let runtime: Runtime;

    beforeEach(() => {
      storage = EmulatedStorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: storage,
      });
    });

    afterEach(async () => {
      await runtime.dispose();
      await storage.close();
    });

    /** Compiles `main` with `page.html` and `note.txt` attached, and sets it up. */
    async function setUp(main: string, cause: string) {
      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          { name: "/main.tsx", contents: main },
          { name: "/page.html", contents: PAGE },
          { name: "/note.txt", contents: NOTE },
        ],
        dataFiles: ["/page.html", "/note.txt"],
      };
      const pattern = await runtime.patternManager.compileOrGetPattern(
        program,
      );
      const tx = runtime.edit();
      runtime.run(
        tx,
        pattern,
        {},
        runtime.getCell(space, cause, undefined, tx),
      );
      await tx.commit().settled;
      return runtime.getCell(space, cause, undefined);
    }

    it("stores a data-file string as a link to its code document", async () => {
      const result = await setUp(
        [
          'import { dataFile, pattern } from "commonfabric";',
          'const PAGE = dataFile("./page.html");',
          "export default pattern(() => ({ page: PAGE }));",
        ].join("\n"),
        "linked-page",
      );

      const stored = (result.getRaw() as { page: unknown }).page;
      expect(parseLink(stored, result)?.id).toBe(codeDocumentId(PAGE));
      expect(result.key("page").get()).toBe(PAGE);
    });

    it("stores a short data-file string inline", async () => {
      const result = await setUp(
        [
          'import { dataFile, pattern } from "commonfabric";',
          'const NOTE = dataFile("./note.txt");',
          "export default pattern(() => ({ note: NOTE }));",
        ].join("\n"),
        "inline-note",
      );

      expect((result.getRaw() as { note: unknown }).note).toBe(NOTE);
    });

    it("stores a long string no data-file reader returned inline", async () => {
      const literal = "sprinkles ".repeat(200);
      const result = await setUp(
        [
          'import { pattern } from "commonfabric";',
          `export default pattern(() => ({ text: ${
            JSON.stringify(literal)
          } }));`,
        ].join("\n"),
        "inline-literal",
      );

      expect((result.getRaw() as { text: unknown }).text).toBe(literal);
    });

    it("hands a render read the string at a view prop", async () => {
      const result = await setUp(
        [
          'import { dataFile, pattern, UI } from "commonfabric";',
          'const PAGE = dataFile("./page.html");',
          "export default pattern(() => ({ [UI]: <cf-iframe src={PAGE} /> }));",
        ].join("\n"),
        "rendered-page",
      );

      const stored = result.getRaw() as {
        [UI]: { props: { src: unknown } };
      };
      expect(parseLink(stored[UI].props.src, result)?.id).toBe(
        codeDocumentId(PAGE),
      );
      const view = result.key(UI).asSchema(rendererVDOMSchema).get() as {
        props: { get(): { src: unknown } };
      };
      expect(renderedProp(view.props.get().src)).toBe(PAGE);
    });

    it("hands a render read the strings of an `assets` record", async () => {
      // A render read stops at an object-valued prop, so a link inside one
      // reads as nothing unless the schema names the prop. `assets` is named.

      const result = await setUp(
        [
          'import { dataFile, pattern, UI } from "commonfabric";',
          'const PAGE = dataFile("./page.html");',
          "export default pattern(() => ({",
          "  [UI]: {",
          '    type: "vnode",',
          '    name: "cf-iframe",',
          "    props: { assets: { page: PAGE } },",
          "    children: [],",
          "  },",
          "}));",
        ].join("\n"),
        "rendered-assets",
      );

      const view = result.key(UI).asSchema(rendererVDOMSchema).get() as {
        props: { get(): { assets: { page: unknown } } };
      };
      expect(renderedProp(view.props.get().assets.page)).toBe(PAGE);
    });
  });
});
