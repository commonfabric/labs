import type { Language } from "../language.ts";
import { utf8Decoder } from "../decoder.ts";
import { createRecoloringHighlighter } from "../classes.ts";
import { proguardDocument, proguardLines } from "./proguard.ts";

/** A line that starts with an option name from ProGuard's reference, whose
 * names share these stems. Options whose names a compiler flag shares, such as
 * `-include`, `-target`, and `-dump`, are not evidence. */
const PROGUARD_OPTION_LINE =
  /^[ \t]*-(?:keep|dont|assume|printmapping|printseeds|printusage|printconfiguration|apply|adapt|optimizations|optimizationpasses|obfuscationdictionary|classobfuscation|packageobfuscation|repackage|flatten|allowaccess|mergeinterfaces|overloadaggressively|useunique|renamesourcefile|injars|outjars|libraryjars|basedirectory|ignorewarnings|whyareyoukeeping|checkdiscard|identifiernamestring|maximumremovedandroidloglevel|addconfigurationdebugging|skipnonpublic|forceprocessing)[a-z]*(?=[\s,]|$)/m;

/**
 * The ProGuard language for the pager, which covers the keep rules ProGuard
 * and R8 read when an Android build shrinks its code. It provides syntax
 * highlighting for direct files, diffs, and live edits. It has no structure
 * navigation or semantic layer.
 */
export const proguardLanguage: Language = {
  id: "proguard",

  input: { kind: "text", decoder: utf8Decoder },

  metadata: {
    extensions: [],
    // The rules files an Android module template creates.
    filenames: ["proguard-rules.pro", "consumer-rules.pro"],
    filenamePatterns: [],
    aliases: ["r8"],
    interpreters: [],
    // Qt project files and Prolog also use `.pro`, and a Qt project's
    // continuation lines can start with compiler flags. A rules file has a line
    // that starts with one of ProGuard's options.
    sharedExtensions: [{ extension: ".pro", content: PROGUARD_OPTION_LINE }],
  },

  parseDocument: (text) => proguardDocument(text),

  highlightLines: (text) => proguardLines(text),

  createHighlighter: (text) => createRecoloringHighlighter(text, proguardLines),

  hunkStructure: () => [],
};
