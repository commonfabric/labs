import { join, toFileUrl } from "@std/path";
import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import {
  KATEX_STYLES,
  KATEX_STYLES_VERSION,
} from "../runtime/ui/src/v2/components/cf-code-editor/features/katex-styles.ts";
import {
  deriveKatexAssets,
  formatFiles,
  generateKatexAssets,
  type KatexDestination,
  readKatexRelease,
} from "./generate-katex-assets.ts";

/** The repository root. */
const ROOT = new URL("../", import.meta.url);

/** The committed shell stylesheet declaring KaTeX's faces. */
const FONTS_STYLESHEET = new URL(
  "runtime/shell/public/styles/katex-fonts.css",
  ROOT,
);

/** The committed module holding KaTeX's layout rules. */
const STYLES_MODULE = new URL(
  "runtime/ui/src/v2/components/cf-code-editor/features/katex-styles.ts",
  ROOT,
);

/** The directory the shell serves KaTeX's fonts from. */
const FONTS_DIRECTORY = new URL("runtime/shell/public/fonts/katex/", ROOT);

/** One face, written the way KaTeX's minified stylesheet writes them. */
const FACE = "@font-face{font-family:KaTeX_Main;font-style:normal;" +
  'src:url(fonts/KaTeX_Main-Regular.woff2) format("woff2"),' +
  'url(fonts/KaTeX_Main-Regular.woff) format("woff")}';

describe("generate-katex-assets", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await Deno.makeTempDir({ prefix: "katex-assets-test-" });
  });

  afterEach(async () => {
    await Deno.remove(directory, { recursive: true });
  });

  describe("deriveKatexAssets()", () => {
    it("returns each face's WOFF2 font, declared at the shell's URL", () => {
      const assets = deriveKatexAssets({
        version: "9.9.9",
        css: `.katex{color:red}${FACE}`,
      });
      expect(assets.fonts).toEqual(["KaTeX_Main-Regular.woff2"]);
      expect(assets.fontsStylesheet).toContain(
        [
          "@font-face {",
          "  font-family:KaTeX_Main;",
          "  font-style:normal;",
          '  src:url("/fonts/katex/KaTeX_Main-Regular.woff2") format("woff2");',
          "}",
        ].join("\n"),
      );
      expect(assets.fontsStylesheet).toContain(
        "KaTeX 9.9.9's font faces",
      );
      expect(assets.fontsStylesheet).not.toContain(".woff)");
    });

    it("returns the layout rules without the faces", () => {
      const assets = deriveKatexAssets({
        version: "9.9.9",
        css: `.katex{color:red}${FACE}.katex-html{display:block}`,
      });
      expect(assets.layout).toBe(".katex{color:red}.katex-html{display:block}");
    });

    it("returns a `body` rule as a rule on the host", () => {
      const assets = deriveKatexAssets({
        version: "9.9.9",
        css: `body{a:b}${FACE}.x{c:d}body{e:f}`,
      });
      expect(assets.layout).toBe(":host{a:b}.x{c:d}:host{e:f}");
    });

    it("returns a selector that merely ends in `body` unchanged", () => {
      const assets = deriveKatexAssets({
        version: "9.9.9",
        css: `.tbody{a:b}${FACE}`,
      });
      expect(assets.layout).toBe(".tbody{a:b}");
    });

    it("throws for a stylesheet that declares no faces", () => {
      expect(() => deriveKatexAssets({ version: "9.9.9", css: ".katex{}" }))
        .toThrow("KaTeX 9.9.9's stylesheet declares no font faces.");
    });

    it("throws for a stylesheet naming a URL outside its faces", () => {
      expect(() =>
        deriveKatexAssets({
          version: "9.9.9",
          css: `.katex{background:url(x.png)}${FACE}`,
        })
      ).toThrow("KaTeX 9.9.9's stylesheet names a URL outside its font faces.");
    });

    it("throws for a face with no WOFF2 source", () => {
      const face = "@font-face{font-family:K;src:url(fonts/K.woff)}";
      expect(() => deriveKatexAssets({ version: "9.9.9", css: face }))
        .toThrow(`A KaTeX font face has no WOFF2 source: \`${face}\``);
    });

    describe("from the release the editor imports", () => {
      // The committed assets are what the generator wrote from that release,
      // so deriving them again reproduces them.

      it("returns the layout rules the editor holds", async () => {
        const release = await readKatexRelease();
        expect(release.version).toBe(KATEX_STYLES_VERSION);
        expect(deriveKatexAssets(release).layout).toBe(KATEX_STYLES);
      });
    });
  });

  describe("generateKatexAssets()", () => {
    it("writes the fonts and the files the repository holds, and returns what it wrote", async () => {
      const base = toFileUrl(`${directory}/`);
      const destination: KatexDestination = {
        stylesModule: new URL("katex-styles.ts", base),
        fontsDirectory: new URL("fonts/katex/", base),
        fontsStylesheet: new URL("katex-fonts.css", base),
      };
      await Deno.mkdir(destination.fontsDirectory, { recursive: true });
      await Deno.writeTextFile(
        new URL("KaTeX_Retired.woff2", destination.fontsDirectory),
        "",
      );

      const said = await generateKatexAssets(destination);

      const served = [...Deno.readDirSync(FONTS_DIRECTORY)]
        .map((entry) => entry.name).sort();
      expect(said).toBe(
        `Wrote KaTeX ${KATEX_STYLES_VERSION}'s layout rules, ` +
          `${served.length} font faces and their fonts.`,
      );
      const written = [...Deno.readDirSync(destination.fontsDirectory)]
        .map((entry) => entry.name).sort();
      expect(written).toEqual(served);
      for (const font of served) {
        expect(await Deno.readFile(new URL(font, destination.fontsDirectory)))
          .toEqual(await Deno.readFile(new URL(font, FONTS_DIRECTORY)));
      }
      expect(await Deno.readTextFile(destination.fontsStylesheet))
        .toBe(await Deno.readTextFile(FONTS_STYLESHEET));
      expect(await Deno.readTextFile(destination.stylesModule))
        .toBe(await Deno.readTextFile(STYLES_MODULE));
    });
  });

  describe("formatFiles()", () => {
    it("throws with what `deno fmt` said for a file it cannot parse", async () => {
      const file = join(directory, "broken.ts");
      await Deno.writeTextFile(file, "export const = ;");
      await expect(formatFiles([toFileUrl(file)])).rejects.toThrow(
        "broken.ts",
      );
      expect(await Deno.readTextFile(file)).toBe("export const = ;");
    });
  });
});
