/**
 * Writes the KaTeX assets the editor's math needs, from the KaTeX package the
 * editor imports. Run it from the repository root after changing that pin in
 * `runtime/ui/deno.jsonc`, and change the two `npm:katex` specifiers below to
 * match:
 *
 * ```sh
 * deno run --allow-read --allow-write --allow-run tasks/generate-katex-assets.ts
 * ```
 *
 * KaTeX's stylesheet is split in two, because a shadow root ignores
 * `@font-face` rules. The rules that lay out math go to a module the editor
 * adopts into its shadow root. The fonts go to the shell, served beside its
 * own fonts and declared by a stylesheet its page loads, so the browser
 * fetches a face only when some formula uses it. Only the WOFF2 source of
 * each face is kept; every browser the shell supports reads it.
 */

import { emptyDir } from "@std/fs";
import * as path from "@std/path";
// The import puts the package in this module's graph, which is what lets
// `import.meta.resolve()` below find its files.
// deno-lint-ignore no-external-import
import katex from "npm:katex@0.19.1";

/** The repository root. */
const ROOT = new URL("../", import.meta.url);

/** Where the shell serves the font files from, as a URL path. */
const FONTS_URL_PATH = "/fonts/katex";

/** One `@font-face` rule; KaTeX's stylesheet nests nothing inside one. */
const FONT_FACE = /@font-face\{[^}]*\}/g;

/** A face's WOFF2 source, as KaTeX's stylesheet names it. */
const WOFF2_SOURCE = /url\(fonts\/([A-Za-z0-9_-]+\.woff2)\)/;

/** A `src` descriptor's list of sources. */
const SOURCES = /src:[^;}]+/;

/** Formats files as the repository formats them, with `deno fmt`. */
export async function formatFiles(files: readonly URL[]): Promise<void> {
  const formatted = await new Deno.Command(Deno.execPath(), {
    args: ["fmt", "--quiet", ...files.map((file) => path.fromFileUrl(file))],
  }).output();
  if (!formatted.success) {
    throw new Error(new TextDecoder().decode(formatted.stderr));
  }
}

/** Where the generator writes. */
export interface KatexDestination {
  /** The module holding KaTeX's layout rules, for the editor's shadow root. */
  readonly stylesModule: URL;

  /** The directory the shell serves `FONTS_URL_PATH` from. */
  readonly fontsDirectory: URL;

  /** The shell stylesheet declaring the font faces. */
  readonly fontsStylesheet: URL;
}

/** The places in this repository that the editor and the shell read. */
const REPOSITORY: KatexDestination = {
  stylesModule: new URL(
    "runtime/ui/src/v2/components/cf-code-editor/features/katex-styles.ts",
    ROOT,
  ),
  fontsDirectory: new URL("runtime/shell/public/fonts/katex/", ROOT),
  fontsStylesheet: new URL("runtime/shell/public/styles/katex-fonts.css", ROOT),
};

/** The KaTeX release the editor imports: its version and its stylesheet. */
export interface KatexRelease {
  readonly version: string;

  /** The path of the stylesheet, beside which its `fonts/` directory sits. */
  readonly stylesheet: string;

  /** The stylesheet's text. */
  readonly css: string;
}

/** Reads the KaTeX release this module imports. */
export async function readKatexRelease(): Promise<KatexRelease> {
  const stylesheet = path.fromFileUrl(
    import.meta.resolve("npm:katex@0.19.1/dist/katex.min.css"),
  );
  return {
    version: katex.version,
    stylesheet,
    css: await Deno.readTextFile(stylesheet),
  };
}

/** What the generator writes, derived from one release's stylesheet. */
export interface KatexAssets {
  /** The rules that lay out math, without the font faces. */
  readonly layout: string;

  /** The WOFF2 file of each face, in the order the stylesheet declares them. */
  readonly fonts: readonly string[];

  /** The text of the module holding `layout`, before it is formatted. */
  readonly stylesModule: string;

  /** The text of the stylesheet declaring the faces. */
  readonly fontsStylesheet: string;
}

/**
 * Splits a release's stylesheet into the rules that lay out math and the
 * faces the shell declares. Throws for a stylesheet the split would lose
 * something from: one with no faces, a face with no WOFF2 source, or a URL
 * outside the faces, which the shadow root would resolve against the wrong
 * base.
 */
export function deriveKatexAssets(
  { version, css }: Pick<KatexRelease, "version" | "css">,
): KatexAssets {
  const faces = css.match(FONT_FACE) ?? [];
  if (faces.length === 0) {
    throw new Error(`KaTeX ${version}'s stylesheet declares no font faces.`);
  }
  // KaTeX resets its equation-number counters on `body`, which a shadow root
  // holds none of, so the rules reset them on the editor's host instead.
  const layout = css.replace(FONT_FACE, "").replace(
    /(^|\})body\{/g,
    "$1:host{",
  );
  if (/url\(/.test(layout)) {
    throw new Error(
      `KaTeX ${version}'s stylesheet names a URL outside its font faces.`,
    );
  }
  const fonts: string[] = [];
  const declarations: string[] = [];
  for (const face of faces) {
    const font = face.match(WOFF2_SOURCE)?.[1];
    if (font === undefined) {
      throw new Error(`A KaTeX font face has no WOFF2 source: \`${face}\``);
    }
    fonts.push(font);
    declarations.push(
      face
        .replace(
          SOURCES,
          `src:url("${FONTS_URL_PATH}/${font}") format("woff2")`,
        )
        .replace(/^@font-face\{/, "@font-face {\n  ")
        .replace(/;(?!$)/g, ";\n  ")
        .replace(/;?\}$/, ";\n}"),
    );
  }
  return {
    layout,
    fonts,
    fontsStylesheet: [
      `/*`,
      ` * KaTeX ${version}'s font faces, for math in the editor's prose mode.`,
      ` * Generated by tasks/generate-katex-assets.ts; run that again rather`,
      ` * than editing this file.`,
      ` */`,
      "",
      declarations.join("\n\n"),
      "",
    ].join("\n"),
    stylesModule: [
      "/**",
      ` * KaTeX ${version}'s stylesheet without its font faces, which the shell`,
      " * declares in `katex-fonts.css`. Generated by",
      " * `tasks/generate-katex-assets.ts`; run that again rather than editing",
      " * this file.",
      " */",
      "",
      "/** The KaTeX version whose stylesheet `KATEX_STYLES` holds. */",
      `export const KATEX_STYLES_VERSION = ${JSON.stringify(version)};`,
      "",
      "/** The rules that lay out KaTeX's output. */",
      `export const KATEX_STYLES = ${JSON.stringify(layout)};`,
      "",
    ].join("\n"),
  };
}

/**
 * Writes the assets of the KaTeX release this module imports to
 * `destination`, replacing whatever font files were there, and returns what
 * it wrote. The written files are formatted as the repository formats them,
 * so a run leaves nothing for `deno fmt --check` to report.
 */
export async function generateKatexAssets(
  destination: KatexDestination,
): Promise<string> {
  const release = await readKatexRelease();
  const assets = deriveKatexAssets(release);
  await emptyDir(destination.fontsDirectory);
  for (const font of assets.fonts) {
    await Deno.copyFile(
      path.join(path.dirname(release.stylesheet), "fonts", font),
      new URL(font, destination.fontsDirectory),
    );
  }
  await Deno.writeTextFile(
    destination.fontsStylesheet,
    assets.fontsStylesheet,
  );
  await Deno.writeTextFile(destination.stylesModule, assets.stylesModule);
  await formatFiles([
    destination.stylesModule,
    destination.fontsStylesheet,
  ]);
  return `Wrote KaTeX ${release.version}'s layout rules, ` +
    `${assets.fonts.length} font faces and their fonts.`;
}

if (import.meta.main) console.log(await generateKatexAssets(REPOSITORY));
