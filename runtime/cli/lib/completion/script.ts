/**
 * The shell functions users install.
 *
 * These are intentionally thin and free of per-command knowledge: they forward
 * the raw line and let `cf completion complete` decide everything. That
 * matters because a sourced completion function lives in the user's shell
 * profile — it is the one piece of this feature that does not get updated when
 * the CLI is rebuilt, so it must not encode a command tree that can go stale.
 *
 * Each script binds two command words. `cf` is the compiled binary; `deno` is
 * bound because the CLI is most often run as `deno task cf …`. The `deno`
 * binding is cooperative: the CLI reports `:cf:notmine` for any `deno` line
 * that is not a CLI invocation, and the function hands back to whatever
 * completed `deno` beforehand, so `deno test`/`deno task build` keep their own
 * completions.
 */

export interface ScriptOptions {
  /** Also complete `deno task cf …`. Defaults to true. */
  readonly denoTask?: boolean;
}

/** Shell-function-safe identifier derived from the installed CLI name. */
function functionName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "_");
}

/**
 * bash completion.
 *
 * Passes `COMP_LINE`/`COMP_POINT` instead of `COMP_WORDS`: bash splits words on
 * `COMP_WORDBREAKS`, which includes `:` and `=`, so `--space=x` and
 * `http://host:8000` would arrive pre-shredded. The CLI tokenizes instead, and
 * the reply is re-trimmed to the fragment bash believes it is replacing.
 *
 * The trailing space is inverted rather than suppressed, because macOS ships
 * bash 3.2 and `compopt` is bash 4+. Registering `-o nospace` and letting a
 * candidate carry its own space is the one mechanism that works on both: the
 * held cursor a cell path needs then costs nothing on the shell this
 * repository is most often developed against.
 */
export function bashCompletionScript(
  name: string,
  options: ScriptOptions = {},
): string {
  const fn = `_${functionName(name)}_complete`;
  const previous = `_${functionName(name)}_deno_previous`;
  const denoTask = options.denoTask !== false;

  const denoBinding = denoTask
    ? `
# Capture the existing \`deno\` completion before rebinding, so non-CLI deno
# lines keep it. Must run before the \`complete -F\` below replaces the spec.
#
# Only a foreign function is recorded, and an already-recorded one is kept.
# Sourcing this script twice (a profile plus bash_completion.d, or a re-sourced
# profile) makes the second pass see the binding the first pass installed;
# capturing that would recurse forever on the next non-CLI \`deno\` completion
# and hang the terminal, while clearing it would silently drop deno's real
# completion.
${previous}="\${${previous}:-}"
if _${functionName(name)}_spec="$(complete -p deno 2>/dev/null)"; then
  if [[ "\${_${
      functionName(name)
    }_spec}" =~ -F[[:space:]]+([^[:space:]]+) ]]; then
    if [[ "\${BASH_REMATCH[1]}" != "${fn}" ]]; then
      ${previous}="\${BASH_REMATCH[1]}"
    fi
  fi
fi
unset _${functionName(name)}_spec

complete -F ${fn} deno
`
    : "";

  return `# bash completion for ${name}
# Install:  ${name} completion bash > /usr/local/etc/bash_completion.d/${name}
#     or:   source <(${name} completion bash)

${fn}() {
  local IFS=$'\\n'
  local cur reply line glob="" nospace=0 notmine=0
  local -a raw
  cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=()

  # Read with a loop rather than \`mapfile\`: macOS ships bash 3.2, where
  # \`mapfile\` does not exist. Errors are discarded — a failing completion must
  # never print into the user's command line.
  while IFS= read -r line; do
    raw+=("\${line}")
  done < <(${name} completion complete --shell bash \\
    --line "\${COMP_LINE}" --point "\${COMP_POINT}" 2>/dev/null)

  for line in "\${raw[@]}"; do
    case "\${line}" in
      ':cf:notmine') notmine=1 ;;
      ':cf:files '*) glob="\${line#:cf:files }" ;;
      ':cf:files')   glob="*" ;;
      ':cf:dirs')    glob=":dirs:" ;;
      ':cf:nospace') nospace=1 ;;
      '') ;;
      *) COMPREPLY+=("\${line}") ;;
    esac
  done

  # Not a ${name} command line (e.g. \`deno test\`): defer to the completion
  # that was bound before us, or to plain filenames.
  if [[ \${notmine} -eq 1 ]]; then
    COMPREPLY=()
    if [[ -n "\${${previous}:-}" ]] && declare -F "\${${previous}}" >/dev/null; then
      "\${${previous}}"
    else
      while IFS= read -r reply; do COMPREPLY+=("\${reply}"); done \\
        < <(compgen -f -- "\${cur}")
    fi
    return
  fi

  # bash replaces only the fragment after the last word-break character, and
  # \${cur} is the whole word — \`--identity=~/keys/a\` rather than \`~/keys/a\`.
  # A glob applied to the whole word matches nothing, so file completion is
  # given the fragment the shell will actually replace.
  local frag="\${cur}"
  if [[ "\${cur}" == *[:=]* ]]; then
    frag="\${cur##*[:=]}"
  fi

  if [[ -n "\${glob}" ]]; then
    if [[ "\${glob}" == ":dirs:" ]]; then
      while IFS= read -r reply; do COMPREPLY+=("\${reply}"); done \\
        < <(compgen -d -- "\${frag}")
    else
      while IFS= read -r reply; do COMPREPLY+=("\${reply}"); done \\
        < <(compgen -f -X "!\${glob}" -- "\${frag}"; compgen -d -- "\${frag}")
    fi
  fi

  # Candidates from the CLI carry the whole word, so trim them by the same
  # amount or the prefix is duplicated. A file candidate is already the
  # fragment and carries no such prefix, so this leaves it alone.
  if [[ "\${cur}" == *[:=]* ]]; then
    local head="\${cur%[:=]*}"
    local i
    for i in "\${!COMPREPLY[@]}"; do
      COMPREPLY[i]="\${COMPREPLY[i]#"\${head}"?}"
    done
  fi

  # A word opening with \`#\` is a comment to an interactive bash, which drops
  # it and everything after it before the command is called: \`wish #profile\`
  # runs \`wish\` with no target. \`\\#profile\` is one word to the shell and the
  # bare \`#profile\` to the command, and completing it again reads back the
  # same target, so the escape is added to the candidate rather than left to
  # the caller to remember.
  local j
  for j in "\${!COMPREPLY[@]}"; do
    case "\${COMPREPLY[j]}" in
      '#'*) COMPREPLY[j]="\\\\\${COMPREPLY[j]}" ;;
    esac
  done

  # The trailing space is inverted rather than suppressed. \`compopt\` is the
  # per-completion switch and it is bash 4+, so the ${name} binding is
  # registered \`-o nospace\` and a candidate that should END the word carries
  # its own space. bash inserts that space verbatim, which is what makes one
  # mechanism serve bash 3.2 and bash 4 alike.
  #
  # \`\$1\` is the command word the compspec fired for, and it decides: a line
  # handed back to another completion has to keep that completion's spacing,
  # so the \`deno\` binding is registered WITHOUT \`-o nospace\` and adds
  # nothing here.
  if [[ "\${1##*/}" == "${name}" && \${nospace} -eq 0 ]]; then
    local k
    for k in "\${!COMPREPLY[@]}"; do
      COMPREPLY[k]="\${COMPREPLY[k]} "
    done
  fi

  # Still worth setting where it exists: it is what gives the \`deno\` binding
  # the same held cursor, which the inversion above cannot reach.
  if [[ \${nospace} -eq 1 ]] && type compopt >/dev/null 2>&1; then
    compopt -o nospace
  fi
}
${denoBinding}
complete -o nospace -F ${fn} ${name}
`;
}

/**
 * zsh completion.
 *
 * zsh already tokenizes respecting quotes, so `words`/`CURRENT` are forwarded
 * directly. `_describe` renders the annotation column, which is what makes an
 * opaque piece id readable — the id completes, its name explains it.
 */
export function zshCompletionScript(
  name: string,
  options: ScriptOptions = {},
): string {
  const fn = `_${functionName(name)}`;
  const previous = `_${functionName(name)}_deno_previous`;
  const denoTask = options.denoTask !== false;

  const denoBinding = denoTask
    ? `
# Capture the existing \`deno\` completer before rebinding, so non-CLI deno
# lines keep it. Must run before the \`compdef\` below overwrites _comps[deno].
#
# Only a foreign completer is recorded, and an already-recorded one is kept.
# Loading this script twice makes the second pass see the binding the first
# installed; capturing that would recurse forever on the next non-CLI \`deno\`
# completion and hang the terminal, while clearing it would silently drop
# deno's real completion.
typeset -g ${previous}="\${${previous}:-}"
if [[ -n "\${_comps[deno]:-}" && "\${_comps[deno]}" != "${fn}" ]]; then
  typeset -g ${previous}="\${_comps[deno]}"
fi

compdef ${fn} deno
`
    : "";

  return `#compdef ${name}
# zsh completion for ${name}
# Install:  ${name} completion zsh > "\${fpath[1]}/_${name}"
#     then: autoload -U compinit && compinit

${fn}() {
  local -a raw entries
  local line glob="" nospace=0 notmine=0

  # Errors are discarded: a failing completion must never interrupt typing.
  raw=("\${(@f)$(${name} completion complete --shell zsh \\
    --cword $((CURRENT - 1)) -- "\${words[@]}" 2>/dev/null)}")

  for line in "\${raw[@]}"; do
    case "\${line}" in
      ':cf:notmine') notmine=1 ;;
      ':cf:files '*) glob="\${line#:cf:files }" ;;
      ':cf:files')   glob="*" ;;
      ':cf:dirs')    glob=":dirs:" ;;
      ':cf:nospace') nospace=1 ;;
      '') ;;
      *) entries+=("\${line}") ;;
    esac
  done

  # Not a ${name} command line (e.g. \`deno test\`): defer to the completer
  # that was bound before us, or to zsh's default.
  if (( notmine )); then
    if [[ -n "\${${previous}:-}" ]] && (( \${+functions[\${${previous}}]} )); then
      "\${${previous}}" "\${@}"
    else
      _default
    fi
    return
  fi

  if [[ -n "\${glob}" ]]; then
    # An inline \`--name=value\` word reaches here whole. Moving the flag and
    # its \`=\` into IPREFIX leaves \`_path_files\` completing the path rather
    # than looking for a file whose name begins with the flag.
    compset -P '--[^=]#='
    if [[ "\${glob}" == ":dirs:" ]]; then
      _path_files -/
    else
      _path_files -g "\${glob}" && return
      _path_files -/
    fi
    return
  fi

  (( \${#entries} )) || return 1

  if (( nospace )); then
    _describe -t ${functionName(name)} '${name}' entries -S ''
  else
    _describe -t ${functionName(name)} '${name}' entries
  fi
}
${denoBinding}
# Support both \`compdef\` autoloading and \`source <(${name} completion zsh)\`.
if [[ "\${funcstack[1]}" == "${fn}" ]]; then
  ${fn} "\${@}"
else
  compdef ${fn} ${name}
fi
`;
}
