import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  complete,
  staticCandidates,
  tokenizeLine,
} from "../lib/completion/mod.ts";
import {
  declaredSlots,
  resolveCompletionLine,
} from "../lib/completion/line.ts";
import { enumeratedOptionNames } from "../lib/completion/static.ts";
import {
  bashCompletionScript,
  zshCompletionScript,
} from "../lib/completion/script.ts";
import { languageNames } from "../lib/view/languages/language.ts";
import { main } from "../commands/main.ts";

function staticFor(line: string): string[] {
  const { words, cword } = tokenizeLine(line, line.length);
  return staticCandidates(resolveCompletionLine(main, words, cword))
    .map((candidate) => candidate.value);
}

/**
 * Drive the full pipeline. Safe without a fabric: every line here resolves to
 * a slot with no live provider, or to one whose context cannot be resolved,
 * and providers degrade to empty rather than reaching the network.
 */
async function completeFor(line: string, shell: "bash" | "zsh" = "bash") {
  const { words, cword } = tokenizeLine(line, line.length);
  return await complete(main, words, cword, shell);
}

Deno.test("top-level completion lists real commands", () => {
  const values = staticFor("cf ");
  for (const expected of ["piece", "check", "inspect", "id", "completion"]) {
    assert(values.includes(expected), `missing ${expected}`);
  }
});

Deno.test("internal plumbing commands are not offered", () => {
  // `fuse-daemon`/`fuse-supervisor` are spawned by `cf fuse`, never typed.
  const values = staticFor("cf ");
  assertFalse(values.includes("fuse-daemon"));
  assertFalse(values.includes("fuse-supervisor"));
});

Deno.test("Cliffy's generated help subcommand is not offered", () => {
  assertFalse(staticFor("cf ").includes("help"));
  assertFalse(staticFor("cf piece ").includes("help"));
});

Deno.test("option names include inherited globals", () => {
  const values = staticFor("cf piece ls --");
  for (const expected of ["--space", "--identity", "--api-url", "--json"]) {
    assert(values.includes(expected), `missing ${expected}`);
  }
});

Deno.test("a single dash offers short flags, a double dash does not", () => {
  assert(staticFor("cf piece ls -").includes("-s"));
  assertFalse(staticFor("cf piece ls --").includes("-s"));
});

Deno.test("pre-parse globals are offered even though they are not in the tree", () => {
  const values = staticFor("cf piece ls --");
  assert(values.includes("--log-level"));
  assert(values.includes("--no-color"));
});

Deno.test("both commands that assign a slug offer the flag that takes a bound name", () => {
  // A boolean flag declares no value, so the completion-slot gate has nothing
  // to require of it; that the name reaches the prompt is what this asserts,
  // on both doors into slug assignment.
  assert(staticFor("cf piece set-slug top --").includes("--force"));
  assert(staticFor("cf piece new --").includes("--force"));
});

Deno.test("an option already supplied is not offered again", () => {
  const values = staticFor("cf piece ls --space team --");
  assertFalse(values.includes("--space"));
  assert(values.includes("--identity"));
});

Deno.test("--log-level completes its accepted levels", async () => {
  assertEquals(await completeFor("cf --log-level "), [
    "debug",
    "info",
    "warn",
    "error",
    "silent",
  ]);
});

Deno.test("--log-level=<value> keeps the inline prefix on candidates", async () => {
  // The shell replaces the whole token, so a bare `debug` would produce
  // `cf --log-level=debug` -> `cf debug`.
  assertEquals(await completeFor("cf --log-level=de"), ["--log-level=debug"]);
});

Deno.test("the inline prefix is attached after the candidates are gathered", () => {
  // `staticCandidates` returns bare values and `complete` attaches the prefix,
  // so one rule covers the static half and the live half alike. Attaching it in
  // the static half alone is what dropped every live candidate for this
  // spelling: the word under the cursor is `--piece=`, and a bare value cannot
  // start with it.
  assertEquals(staticFor("cf --log-level=de"), [
    "debug",
    "info",
    "warn",
    "error",
    "silent",
  ]);
});

Deno.test("cf view --language completes its accepted names", async () => {
  assertEquals(await completeFor("cf view --language "), languageNames());
});

Deno.test("candidates are filtered by the typed prefix", async () => {
  const values = await completeFor("cf piece se");
  assert(values.length > 0);
  for (const value of values) {
    assert(value.startsWith("se"), `${value} does not match prefix`);
  }
});

Deno.test("zsh output pairs a candidate with its description", async () => {
  const values = await completeFor("cf ", "zsh");
  const piece = values.find((value) => value.startsWith("piece:"));
  assert(piece, "expected a described `piece` candidate");
});

Deno.test("zsh output escapes colons inside values", async () => {
  // `_describe` splits on the first unescaped colon; an api-url has two, and
  // an unescaped one truncates the inserted value.
  const values = await completeFor("cf piece ls -a ", "zsh");
  const local = values.find((value) => value.includes("localhost"));
  assert(local, "expected a localhost api-url candidate");
  assert(
    local.startsWith("http\\://"),
    `colons must be escaped, got ${local}`,
  );
});

Deno.test("bash output carries values only", async () => {
  const values = await completeFor("cf ", "bash");
  for (const value of values) {
    assertFalse(value.includes(":"), `bash candidates carry no description`);
  }
});

Deno.test("pattern-file arguments defer to the shell's file completion", async () => {
  // The shell handles quoting, `~`, and directories far better than we can.
  assertEquals(await completeFor("cf check "), [":cf:files *.tsx"]);
  assertEquals(await completeFor("cf piece new "), [":cf:files *.tsx"]);
});

Deno.test("--identity defers to file completion filtered to keyfiles", async () => {
  assertEquals(await completeFor("cf piece ls -i "), [":cf:files *.key"]);
});

Deno.test("--root defers to directory completion", async () => {
  assertEquals(await completeFor("cf piece new --root "), [":cf:dirs"]);
});

Deno.test("--test defers to pattern file completion", async () => {
  assertEquals(await completeFor("cf piece new --test "), [
    ":cf:files *.tsx",
  ]);
});

Deno.test("--datafile defers to unfiltered file completion", async () => {
  assertEquals(await completeFor("cf piece new --datafile "), [
    ":cf:files",
  ]);
});

Deno.test("a live slot with no resolvable context yields nothing, not an error", async () => {
  // Mid-keystroke with no identity configured: silence is the correct signal.
  const previous = Deno.env.get("CF_IDENTITY");
  Deno.env.delete("CF_IDENTITY");
  try {
    assertEquals(await completeFor("cf piece call --piece "), []);
  } finally {
    if (previous !== undefined) Deno.env.set("CF_IDENTITY", previous);
  }
});

Deno.test("a non-CLI deno line hands back to deno's own completion", async () => {
  assertEquals(await completeFor("deno test "), [":cf:notmine"]);
  assertEquals(await completeFor("deno task build-binaries "), [":cf:notmine"]);
});

Deno.test("a deno task cf line completes as cf", async () => {
  const values = await completeFor("deno task cf piece l");
  assertEquals(values, ["ls", "link"]);
});

Deno.test("generated scripts bind both the CLI name and deno", () => {
  const bash = bashCompletionScript("cf");
  assert(bash.includes("complete -o nospace -F _cf_complete cf"));
  assert(bash.includes("complete -F _cf_complete deno"));

  const zsh = zshCompletionScript("cf");
  assert(zsh.includes("compdef _cf deno"));
});

Deno.test("--no-deno-task omits the deno binding", () => {
  const bash = bashCompletionScript("cf", { denoTask: false });
  assert(bash.includes("complete -o nospace -F _cf_complete cf"));
  assertFalse(bash.includes("complete -F _cf_complete deno"));
  assertFalse(bash.includes("complete -p deno"));

  const zsh = zshCompletionScript("cf", { denoTask: false });
  assert(zsh.includes("compdef _cf cf"));
  assertFalse(zsh.includes("compdef _cf deno"));
});

Deno.test("generated scripts refuse to chain to themselves", () => {
  // Sourcing twice (profile plus bash_completion.d, or a re-sourced profile)
  // makes the second pass observe the binding the first installed. Capturing
  // it recurses forever on the next non-CLI `deno` completion and hangs the
  // terminal; this guard is the only thing preventing that.
  const bash = bashCompletionScript("cf");
  assert(bash.includes(`!= "_cf_complete"`), "bash must reject a self-capture");

  const zsh = zshCompletionScript("cf");
  assert(zsh.includes(`!= "_cf"`), "zsh must reject a self-capture");
});

Deno.test("generated scripts keep an already-captured deno completion", () => {
  // The guard must not clear a good value recorded by an earlier source, or a
  // re-source silently drops deno's real completion.
  const bash = bashCompletionScript("cf");
  assert(bash.includes('_cf_deno_previous="${_cf_deno_previous:-}"'));

  const zsh = zshCompletionScript("cf");
  assert(zsh.includes('_cf_deno_previous="${_cf_deno_previous:-}"'));
});

Deno.test("generated scripts capture the previous deno completion before rebinding", () => {
  // Order matters: reading the old spec after `complete -F` would capture
  // our own function and recurse.
  const bash = bashCompletionScript("cf");
  assert(
    bash.indexOf("complete -p deno") <
      bash.indexOf("complete -F _cf_complete deno"),
  );
  const zsh = zshCompletionScript("cf");
  assert(zsh.indexOf("_comps[deno]") < zsh.indexOf("compdef _cf deno"));
});

Deno.test("generated bash script globs the fragment the shell replaces", () => {
  // `$cur` is the whole word (`--identity=~/keys/a`), while readline replaces
  // only what follows the last word-break character. A glob applied to the
  // whole word matches no file at all, which is how `--identity=<TAB>` came to
  // offer nothing while `--identity <TAB>` worked.
  const code = bashCompletionScript("cf").split("\n")
    .filter((line) => !line.trim().startsWith("#"));
  const globbing = code.filter((line) => line.includes("compgen -f -X"));
  assert(globbing.length > 0, "expected a glob-filtered compgen");
  for (const line of globbing) {
    assert(
      line.includes('"${frag}"') && !line.includes('"${cur}"'),
      `glob applied to the whole word: ${line}`,
    );
  }
});

Deno.test("generated zsh script moves an inline flag prefix out of the way", () => {
  // zsh's `_path_files` completes against `$PREFIX`, which for `--identity=`
  // is the whole word. `compset -P` moves the flag into `IPREFIX` so the path
  // is what gets completed.
  // Comments stripped first: they name both, and in the other order.
  const code = zshCompletionScript("cf").split("\n")
    .filter((line) => !line.trim().startsWith("#")).join("\n");
  const compset = code.indexOf("compset -P");
  const pathFiles = code.indexOf("_path_files");
  assert(compset !== -1, "expected the inline prefix to be compset away");
  assert(compset < pathFiles, "compset must precede the file completion");
});

Deno.test("generated bash script inverts the trailing space rather than suppressing it", () => {
  // `compopt` is bash 4+ and macOS ships 3.2, so the space cannot be taken
  // away per completion. The binding is registered `-o nospace` and a
  // candidate that should end the word carries its own space instead, which
  // is one mechanism for both bash versions.
  const bash = bashCompletionScript("cf");
  const code = bash.split("\n").filter((line) => !line.trim().startsWith("#"));
  assert(
    code.some((line) => /^complete -o nospace -F \S+ cf$/.test(line.trim())),
    "the cf binding must register -o nospace",
  );
  assert(
    code.some((line) => line.includes('COMPREPLY[k]="${COMPREPLY[k]} "')),
    "a candidate ending the word must carry its own space",
  );
});

Deno.test("generated bash script leaves the deno binding's spacing alone", () => {
  // A line handed back to another completion keeps that completion's spacing,
  // so the deno binding is registered without `-o nospace` and the function
  // adds nothing for it.
  const code = bashCompletionScript("cf").split("\n")
    .filter((line) => !line.trim().startsWith("#"));
  assert(
    code.some((line) => /^complete -F \S+ deno$/.test(line.trim())),
    "the deno binding must not register -o nospace",
  );
  assert(
    code.some((line) => line.includes('"${1##*/}" == "cf"')),
    "the space must be added only for the binding that asked for it",
  );
});

Deno.test("generated bash script escapes a candidate that would open a comment", async () => {
  // `#profile` written into an interactive bash is a comment: the word, and
  // the rest of the line with it, never reaches the command. `\#profile` is
  // one word to the shell and the bare target to the CLI, and completing it
  // again reads back the same target — so the candidate carries the escape
  // rather than the caller having to remember it. Run through a real bash,
  // because what is being asserted is what bash does with the script.
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/cf`,
      "#!/bin/sh\nprintf '#profileName\\n/\\nplain\\n'\n",
    );
    await Deno.chmod(`${dir}/cf`, 0o755);
    await Deno.writeTextFile(`${dir}/cf.bash`, bashCompletionScript("cf"));
    const { stdout } = await new Deno.Command("/bin/bash", {
      args: [
        "--norc",
        "--noprofile",
        "-c",
        [
          `PATH="${dir}:$PATH"`,
          `. "${dir}/cf.bash"`,
          `COMP_LINE='cf wish #profileN'`,
          "COMP_POINT=17",
          `COMP_WORDS=(cf wish '#profileN')`,
          "COMP_CWORD=2",
          "_cf_complete cf",
          `printf '[%s]' "\${COMPREPLY[@]}"`,
        ].join("\n"),
      ],
    }).output();
    // Only the hashtag is escaped, and the trailing space each candidate
    // carries is outside the escape.
    assertEquals(
      new TextDecoder().decode(stdout),
      "[\\#profileName ][/ ][plain ]",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("generated bash script avoids bash 4 builtins", () => {
  // macOS ships bash 3.2: `mapfile` does not exist at all, and `compopt` is
  // absent so it must be probed before use. Match on invocations rather than
  // on the words appearing in explanatory comments.
  const bash = bashCompletionScript("cf");
  const code = bash.split("\n").filter((line) => !line.trim().startsWith("#"));
  assertFalse(
    code.some((line) => /(^|[;&|( ])mapfile\b/.test(line)),
    "mapfile is bash 4+",
  );

  const guard = bash.indexOf("type compopt >/dev/null 2>&1");
  assert(guard !== -1, "compopt must be probed before use");
  assert(
    guard < bash.indexOf("compopt -o nospace"),
    "the compopt probe must precede the call",
  );
});

Deno.test("the CLI name flows into the generated function names", () => {
  const script = bashCompletionScript("mycf");
  assert(script.includes("_mycf_complete()"));
  assert(script.includes("complete -o nospace -F _mycf_complete mycf"));
});

Deno.test("every enumerated option name answers at each slot that declares it", () => {
  // `enumeratedOptionNames` is what the slot gate subtracts from the command
  // tree, so a name it reports has to answer at the prompt too — otherwise the
  // gate reads a slot as decided while the slot offers nothing. `--log-level`
  // is stripped before Cliffy parses and so declares no slot on the tree; it
  // answers at the root, where the pre-parse globals are read.
  const declared = declaredSlots(main).options;
  for (const name of enumeratedOptionNames()) {
    for (const where of declared.get(name) ?? ["<root>"]) {
      const path = where === "<root>" ? "" : `${where} `;
      const values = staticFor(`cf ${path}--${name} `);
      assert(values.length > 0, `--${name} offers nothing on ${where}`);
    }
  }
});
