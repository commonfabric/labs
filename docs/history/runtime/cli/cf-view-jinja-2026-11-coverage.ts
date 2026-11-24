/**
 * Counts how well the shipped `cf view` Jinja path covers a set of Jinja
 * templates: whether each reconstructs exactly, how many Jinja regions they
 * hold, and, for each language selected, how many characters other than white
 * space inside and outside the regions have no token class.
 *
 * Run it from `runtime/cli`, naming a checkout and a file that lists the
 * templates' paths inside it, one to a line:
 *
 *   deno run --allow-read --allow-env \
 *     ../../docs/history/runtime/cli/cf-view-jinja-2026-11-coverage.ts \
 *     ~/dev/commonfabric/infra/root templates.txt
 */

import {
  languageForSource,
  prepareLanguages,
} from "../../../../runtime/cli/lib/view/languages/language.ts";
import { jinjaSyntax } from "../../../../runtime/cli/lib/view/languages/jinja/jinja.ts";

const [checkout, list] = Deno.args;
const paths = Deno.readTextFileSync(list).trim().split("\n");

interface Counts {
  templates: number;
  inside: number;
  insidePlain: number;
  outside: number;
  outsidePlain: number;
}

const byLanguage = new Map<string, Counts>();
let regions = 0;
for (const path of paths) {
  const text = Deno.readTextFileSync(`${checkout}/${path}`);
  const language = languageForSource(path, text);
  await prepareLanguages([language]);
  const inRegion = new Uint8Array(text.length);
  const scan = jinjaSyntax.scan(text);
  regions += scan.regions.length;
  for (const { start, end } of scan.regions) inRegion.fill(1, start, end);
  const document = language.parseDocument(text, path);
  const rebuilt = document.lines.map((line) =>
    line.spans.map((span) => span.text).join("")
  ).join("\n");
  if (rebuilt !== text) throw new Error(`${path} did not reconstruct`);
  const counts = byLanguage.get(language.id) ??
    { templates: 0, inside: 0, insidePlain: 0, outside: 0, outsidePlain: 0 };
  counts.templates++;
  let offset = 0;
  for (const line of document.lines) {
    for (const span of line.spans) {
      for (let i = 0; i < span.text.length; i++) {
        if (/\s/.test(span.text[i])) continue;
        const plain = span.cls === "plain" ? 1 : 0;
        if (inRegion[offset + i]) {
          counts.inside++;
          counts.insidePlain += plain;
        } else {
          counts.outside++;
          counts.outsidePlain += plain;
        }
      }
      offset += span.text.length;
    }
    offset++;
  }
  byLanguage.set(language.id, counts);
}

console.log(JSON.stringify(
  { templates: paths.length, regions, byLanguage: Object.fromEntries(byLanguage) },
  null,
  2,
));
