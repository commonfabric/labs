#!/usr/bin/env bash
# Put `cf` on PATH.
#
# The one route to a `cf` on PATH, for mise users and everyone else; mise.toml
# pins Deno and declares no PATH entry. Shell completion is what makes this
# matter: the installed completion
# function calls `cf` by name on every Tab and swallows its errors, so with no
# `cf` on PATH completion silently yields nothing.
#
# It installs a COPY, not a symlink. `bin/cf` is self-contained — its job is to
# work out which checkout to run and hand off to it — so a copy carries the
# whole lookup: $CF_LABS_ROOT, then the nearest checkout walking up from the
# cwd. Neither depends on where the copy itself lives, so no particular
# checkout has to survive for the install to keep working.
#
# `bin/cfsh` is installed beside it, and survives being copied for a simpler
# reason: it is a forward to `cf sh` and finds `cf` by name, so it depends on
# PATH and on nothing about where it sits. It has no checkout to bake in,
# which is why only `cf` is rewritten on the way through.
#
# The one thing a copy cannot infer is which checkout to use when you are
# outside every checkout. That is baked in here as DEFAULT_LABS_ROOT, pointed
# at the PRIMARY checkout, since worktrees are removed routinely.
#
# The tradeoff is that upgrades are not free: a change to the lookup strategy
# reaches an installed copy only when this is re-run.
#
# It never edits your shell rc. The completion line is printed for you to add.

set -euo pipefail

target_dir=""
dry_run=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir)
      target_dir="${2:-}"
      if [ -z "${target_dir}" ]; then
        echo "install-cf: --dir requires a path" >&2
        exit 2
      fi
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    -h | --help)
      cat <<'USAGE'
Usage: deno task install-cf [--dir <path>] [--dry-run]

  --dir <path>   Install into <path> instead of an auto-detected directory.
  --dry-run      Report what would happen; change nothing.

Installs copies of bin/cf and bin/cfsh onto PATH. bin/cf carries the checkout
lookup with it and bakes in the primary checkout as the default for when you
are outside every checkout; bin/cfsh opens a shuttle, the interactive shell,
and finds cf on PATH rather than baking anything in. Re-run it to upgrade both.
Prints the shell-completion line to add; never edits your shell rc.
USAGE
      exit 0
      ;;
    *)
      echo "install-cf: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

repo_root="$(git rev-parse --show-toplevel)"

# Two separate questions, deliberately not conflated.
#
# WHICH SCRIPT to copy: this checkout's, always. You invoked this checkout's
# task, so this is the version you meant — including one carrying changes that
# have not landed on main yet.
source_path="${repo_root}/bin/cf"
if [ ! -f "${source_path}" ]; then
  echo "install-cf: ${source_path} not found." >&2
  exit 1
fi

# WHICH DEFAULT to bake in for when you are outside every checkout: the primary
# checkout, so it survives `git worktree remove`. The common dir is
# <primary>/.git for a normal clone. A primary that is not a usable checkout (a
# bare repo, say) leaves this one, which is worth saying out loud.
common_dir="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
primary="$(dirname "${common_dir}")"
fell_back=0
if [ ! -f "${primary}/runtime/cli/launcher.ts" ]; then
  fell_back=1
  primary="${repo_root}"
fi

on_path() {
  case ":${PATH}:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Only ever choose a directory already on PATH — installing somewhere unreachable
# reproduces the silent failure this exists to prevent.
if [ -z "${target_dir}" ]; then
  for candidate in "${HOME}/.local/bin" "${HOME}/bin"; do
    if on_path "${candidate}"; then
      target_dir="${candidate}"
      break
    fi
  done
fi

if [ -z "${target_dir}" ]; then
  cat >&2 <<EOF
install-cf: no install directory found on your PATH.

  Checked: ${HOME}/.local/bin, ${HOME}/bin

  Add one to PATH and re-run, for example:

    mkdir -p "${HOME}/.local/bin"
    echo 'export PATH="\${HOME}/.local/bin:\${PATH}"' >> ~/.zshrc

  Or choose a directory explicitly:

    deno task install-cf --dir /somewhere/on/your/path
EOF
  exit 1
fi

install_path="${target_dir}/cf"
shell_install_path="${target_dir}/cfsh"
shell_source_path="${repo_root}/bin/cfsh"
if [ ! -f "${shell_source_path}" ]; then
  echo "install-cf: ${shell_source_path} not found." >&2
  exit 1
fi

# Checked before the dry-run exit, so a dry run predicts the real run rather
# than reporting a success the real run would not deliver.
if [ ! -d "${target_dir}" ]; then
  echo "install-cf: ${target_dir} does not exist." >&2
  exit 1
fi

# Auto-detection only ever picks a directory already on PATH; an explicit --dir
# can point anywhere, and installing somewhere unreachable is precisely the
# silent failure this exists to prevent. Explicit intent is honored, but not
# quietly.
if ! on_path "${target_dir}"; then
  echo "install-cf: warning: ${target_dir} is not on your PATH," >&2
  echo "            so \`cf\` will not be runnable by name from it." >&2
fi

if [ "${dry_run}" -eq 1 ]; then
  echo "install-cf: would install ${install_path} (default checkout: ${primary})"
  echo "install-cf: would install ${shell_install_path}"
  exit 0
fi

# Replace only something this script wrote. A file someone put there by hand is
# not ours to clobber, and neither is a symlink pointing somewhere unrelated.
refuse_foreign_file() {
  if [ -e "$1" ] || [ -L "$1" ]; then
    if ! grep -q '^# installed by scripts/install-cf.sh$' "$1" 2>/dev/null; then
      echo "install-cf: $1 exists and was not installed by this script;" >&2
      echo "            leaving it alone. Remove it first, or use --dir." >&2
      exit 1
    fi
  fi
}

refuse_foreign_file "${install_path}"
refuse_foreign_file "${shell_install_path}"

# Both copies are written to a temp file and moved into place, so a failure
# part-way cannot leave half a file on PATH. The marker goes after the shebang,
# which has to stay on line 1.
tmp_path="${install_path}.install-cf.$$"
shell_tmp_path="${shell_install_path}.install-cf.$$"
trap 'rm -f "${tmp_path}" "${shell_tmp_path}"' EXIT

{
  head -n 1 "${source_path}"
  echo "# installed by scripts/install-cf.sh"
  tail -n +2 "${source_path}" |
    sed "s|^DEFAULT_LABS_ROOT=\"\"$|DEFAULT_LABS_ROOT=\"${primary}\"|"
} >"${tmp_path}"

if ! grep -q "^DEFAULT_LABS_ROOT=\"${primary}\"$" "${tmp_path}"; then
  echo "install-cf: could not set the default checkout in the copy." >&2
  echo "            ${source_path} no longer has the expected DEFAULT_LABS_ROOT line." >&2
  exit 1
fi

# `cfsh` takes the marker and nothing else: it holds no checkout to bake in,
# reaching whichever one `cf` resolves.
{
  head -n 1 "${shell_source_path}"
  echo "# installed by scripts/install-cf.sh"
  tail -n +2 "${shell_source_path}"
} >"${shell_tmp_path}"

chmod +x "${tmp_path}" "${shell_tmp_path}"
mv "${tmp_path}" "${install_path}"
mv "${shell_tmp_path}" "${shell_install_path}"
trap - EXIT

echo "install-cf: installed ${install_path}"
echo "install-cf: installed ${shell_install_path}"
echo "install-cf: default checkout ${primary} (used only outside any checkout)"

if [ "${fell_back}" -eq 1 ] && [ "${primary}" != "$(dirname "${common_dir}")" ]; then
  cat >&2 <<EOF

Warning: the default checkout is this one, not the primary, because
  $(dirname "${common_dir}")/bin/cf
does not exist there yet. If this is a worktree and you later remove it, \`cf\`
will still work inside any other checkout, but not outside all of them. Update
the primary checkout and re-run for a stable default.
EOF
fi

echo

case "${SHELL##*/}" in
  bash) rc="~/.bashrc" shell="bash" ;;
  *) rc="~/.zshrc" shell="zsh" ;;
esac

cat <<EOF
Shell completion is not installed automatically. Add this to ${rc}:

    source <(cf completion ${shell})
EOF

if [ "${shell}" = "zsh" ]; then
  echo
  echo "  (after your \`compinit\` line)"
fi
