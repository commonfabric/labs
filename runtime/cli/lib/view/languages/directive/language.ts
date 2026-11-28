import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { remapStructure } from "../../diffremap.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { firstContentLineMatches } from "../evidence.ts";
import { directiveDocument, directiveLines } from "./directive.ts";

/** The sections an Apache configuration can open with. */
const APACHE_SECTION =
  "Directory|Files|Location|VirtualHost|IfModule|IfDefine|IfVersion|IfFile" +
  "|IfDirective|IfSection|If|ElseIf|Else|Proxy|Macro|Limit|LimitExcept" +
  "|RequireAll|RequireAny|RequireNone";

/**
 * The evidence a `.conf` file gives for directive configuration: it does not
 * open with a shebang, and its first line other than blank lines and `#` or
 * `;` comments starts a Netdata `alarm` or `template` entry, opens an Apache
 * section, starts with a sysusers.d `u`, `g`, or `m` line (its `r` lines look
 * like tmpfiles.d's), or starts with a word that neither ends with `:` nor
 * holds or precedes `=` and then holds a `;` or a `{` that does not follow `$`
 * or `%`. INI, systemd, and YAML configuration rarely open in any of those
 * ways, JSON and XML open with punctuation, and a shebang belongs to a script.
 */
const DIRECTIVE_LINE = firstContentLineMatches(
  "#;",
  new RegExp(
    String.raw`[^\S\n]*(?:` +
      String.raw`(?:alarm|template)[^\S\n]*:` +
      String.raw`|<(?i:(?:${APACHE_SECTION})(?:Match)?)\b` +
      String.raw`|[ugm]!?[^\S\n]+[^\s#=]` +
      String
        .raw`|(?![^\s;]*:\s)(?![^\s=]*[^\S\n]*=)[A-Za-z_][^\n#]*?(?:;|(?<![$%])\{))`,
  ),
);

/**
 * The directive configuration language for the pager, which covers nginx,
 * Apache httpd, nftables, Netdata health alerts, and sysusers.d. It provides
 * syntax highlighting for direct files, diffs, and live edits, and a structure
 * tree of blocks, sections, and alert entries. It has no semantic layer.
 */
export const directiveLanguage: Language = {
  id: "directive",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [".nft"],
    filenames: [".htaccess", "nftables.conf"],
    filenamePatterns: [/^(?:nginx|httpd|apache2?)(?:[-_.][\w.-]*)?\.conf$/i],
    aliases: [
      "nginx",
      "apache",
      "apacheconf",
      "nftables",
      "nft",
      "netdata",
      "sysusers",
    ],
    interpreters: ["nft"],
    signatures: [],
    sharedExtensions: [{
      extension: ".conf",
      content: (text) => !text.startsWith("#!") && DIRECTIVE_LINE(text),
    }],
  },

  parseDocument: (text) => directiveDocument(text),

  highlightLines: (text) => directiveLines(text),

  highlightFullFileOnDiffEdit: true,

  createHighlighter: (text) =>
    createRecoloringHighlighter(text, directiveLines),

  hunkStructure: (ctx) => remapStructure(ctx),
};
