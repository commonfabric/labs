import { expect } from "@std/expect";

import { taggedHashStringOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { dataFileUrl } from "@commonfabric/text/data-file";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

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

/**
 * The `src` a render read hands the first `cf-iframe` in `view`, following
 * each cell the read returns, as the reconciler subscribes to it.
 */
function srcOf(view: unknown): unknown {
  const node = renderedProp(view);
  if (Array.isArray(node)) {
    for (const child of node) {
      const src = srcOf(child);
      if (src !== undefined) return src;
    }
    return undefined;
  }
  if (typeof node !== "object" || node === null) return undefined;
  const { name, props, children } = node as {
    name?: unknown;
    props?: unknown;
    children?: unknown;
  };
  if (name === "cf-iframe") {
    return renderedProp((renderedProp(props) as { src?: unknown }).src);
  }
  return srcOf(children);
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
              scope: "space",
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

        it("keeps the holes of an array it copies", () => {
          const strings = new DataFileStrings();
          strings.record(PAGE);
          // deno-lint-ignore no-sparse-arrays
          const sparse = [PAGE, , "kept"];

          const { value } = strings.linkInto(sparse, space);

          expect(1 in (value as unknown[])).toBe(false);
          expect((value as unknown[]).length).toBe(3);
        });

        it("leaves inline a string longer than everything it holds together", () => {
          const strings = new DataFileStrings();
          const huge = "glaze".repeat(7 * 1024 * 1024);
          strings.record(huge);

          expect(strings.linkInto([huge], space).documents).toEqual([]);
        });

        it("leaves inline a string it dropped once full", () => {
          // The set holds at most 32 Mi characters, so the 33rd string of
          // 1 Mi characters drops the one used least recently, the first.

          const strings = new DataFileStrings();
          const texts = Array.from(
            { length: 33 },
            (_, i) => `${i}:`.padEnd(1024 * 1024, "glaze"),
          );
          for (const text of texts) strings.record(text);

          const { documents } = strings.linkInto([texts[0], texts[32]], space);

          expect(documents).toEqual([texts[32]]);
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

    it("stores a URL `dataFile.url()` built as a link to its code document", async () => {
      const svg = `<svg>${"<g/>".repeat(300)}</svg>`;
      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          {
            name: "/main.tsx",
            contents: [
              'import { dataFile, pattern } from "commonfabric";',
              'const LOGO = dataFile.url("./logo.svg");',
              "export default pattern(() => ({ logo: LOGO }));",
            ].join("\n"),
          },
          { name: "/logo.svg", contents: svg },
        ],
        dataFiles: ["/logo.svg"],
      };
      const pattern = await runtime.patternManager.compileOrGetPattern(
        program,
      );
      const tx = runtime.edit();
      runtime.run(
        tx,
        pattern,
        {},
        runtime.getCell(space, "logo", undefined, tx),
      );
      await tx.commit().settled;
      const result = runtime.getCell(space, "logo", undefined);

      const url = dataFileUrl(svg, "logo.svg");
      const stored = (result.getRaw() as { logo: unknown }).logo;
      expect(parseLink(stored, result)?.id).toBe(codeDocumentId(url));
      expect(result.key("logo").get()).toBe(url);
    });

    describe("a later setup", () => {
      /** A program reading `page.html` into its result, as `label` says. */
      const reading = (label: string) =>
        [
          'import { dataFile, pattern } from "commonfabric";',
          'const PAGE = dataFile("./page.html");',
          `export default pattern(() => ({ page: PAGE, label: "${label}" }));`,
        ].join("\n");

      /** Whether setting `main` up over `cause` would rewrite its result. */
      async function rewrites(main: string, cause: string): Promise<boolean> {
        const pattern = await runtime.patternManager.compileOrGetPattern({
          main: "/main.tsx",
          files: [
            { name: "/main.tsx", contents: main },
            { name: "/page.html", contents: PAGE },
          ],
          dataFiles: ["/page.html"],
        });
        const tx = runtime.edit();
        try {
          return runtime.runner.setupRewritesResultProjection(
            tx,
            pattern,
            runtime.getCell(space, cause, undefined, tx),
          );
        } finally {
          tx.abort();
        }
      }

      it("leaves a stored link alone when the projection is the same", async () => {
        await setUp(reading("same"), "unchanged-link");

        // Another pattern, so that the comparison runs, with the same
        // projection.
        expect(
          await rewrites(reading("same") + "\n// another", "unchanged-link"),
        ).toBe(false);
      });

      it("rewrites a string stored inline as a link", async () => {
        await setUp(reading("inline"), "inline-page");
        const tx = runtime.edit();
        runtime.getCell(space, "inline-page", undefined, tx).setRawUntyped({
          page: PAGE,
          label: "inline",
        });
        await tx.commit().settled;

        expect(
          await rewrites(reading("inline") + "\n// another", "inline-page"),
        ).toBe(true);
      });
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

    for (const scope of ["PerSession", "PerUser"]) {
      it(`hands a render read the string in a view that reads ${scope} state`, async () => {
        // A view computed from scoped state that builds a sub-pattern is
        // written into a document of that scope, and a link holding no scope
        // of its own takes the scope of the document it is in. The code
        // document is in the space.

        const result = await setUp(
          [
            "import {",
            "  computed, dataFile, Default, pattern, PerSession, PerUser, UI,",
            "  Writable,",
            '} from "commonfabric";',
            'const PAGE = dataFile("./page.html");',
            `interface Input { mode: ${scope}<Writable<string | Default<"a">>> }`,
            "const Label = pattern<{ mode: Writable<string> }>(({ mode }) => ({",
            "  [UI]: <span>{mode}</span>,",
            "}));",
            "export default pattern<Input>(({ mode }) => ({",
            "  [UI]: computed(() =>",
            '    mode.get() === "a"',
            "      ? <div><cf-iframe src={PAGE} />{Label({ mode })}</div>",
            "      : <p>other</p>",
            "  ),",
            "}));",
          ].join("\n"),
          `scoped-view-${scope}`,
        );
        const view = result.key(UI).asSchema(rendererVDOMSchema);
        await view.pull();

        expect(srcOf(view.get())).toBe(PAGE);
      });
    }

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
