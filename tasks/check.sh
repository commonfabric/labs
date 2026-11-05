#!/usr/bin/env bash
set -e
shopt -s extglob nullglob

# Figure out the symlink-resolved program name and directory.
cmdName="$(readlink -f "$0")" || exit "$?"
cmdDir="${cmdName%/*}"
cmdName="${cmdName##*/}"
baseDir="${cmdDir%/*}" # Parent of `cmdDir`, repo root in this case.

# Switch to the root of the project, so that this script can be called when
# `cd`ed anywhere. This is especially useful because the LLM agents often like
# to do `git commit` (which triggers this) in a project subdirectory.
cd "${baseDir}"

# The exact Deno version for this repository is pinned in mise.toml, which mise
# installs (see README.md). A run under any other version stops before
# checking: different Deno versions carry different TypeScript compilers,
# which can return different verdicts on one tree, and an off-pin verdict is
# not the verdict this check exists to report. DENO_CHECK_VERSION_LENIENT=1
# accepts an off-pin version inside the range below; the mismatch is then
# reported again after the diagnostics, where it is the last thing on screen.
# tasks/check-deno-pins.ts verifies that the range contains the pin.
DENO_VERSION_MIN="2.9.8"
DENO_VERSION_MAX="2.10.0"
if [[ ! -f mise.toml ]]; then
  # Checked before the read: `set -e` would otherwise abort on sed's exit
  # status with only sed's own message.
  echo "ERROR: mise.toml not found; cannot read the pinned Deno version."
  exit 1
fi
DENO_PINS="$(sed -n 's/^deno = "\([^"]*\)"$/\1/p' mise.toml)"
# Counted rather than taking the first: TOML rejects a key defined twice, so a
# second pin means mise cannot load the file, and reading past it would report
# a version no developer actually gets.
DENO_PIN_COUNT="$(printf '%s' "${DENO_PINS}" | grep -c . || true)"
if (( DENO_PIN_COUNT == 0 )); then
  echo "ERROR: Could not read the pinned Deno version from mise.toml."
  exit 1
fi
if (( DENO_PIN_COUNT > 1 )); then
  echo "ERROR: mise.toml defines the Deno pin ${DENO_PIN_COUNT} times; TOML rejects a key defined twice, so mise cannot load it."
  exit 1
fi
DENO_VERSION_PINNED="${DENO_PINS}"
# This is more portable than parsing `deno --version`
DENO_VERSION=$(echo "console.log(Deno.version.deno)" | deno run -)
IFS='.' read -r DENO_MAJOR DENO_MINOR DENO_PATCH <<<"${DENO_VERSION}"
if [[ ! "${DENO_MAJOR}" =~ ^[0-9]+$ || ! "${DENO_MINOR}" =~ ^[0-9]+$ || ! "${DENO_PATCH}" =~ ^[0-9]+$ ]]; then
  echo "ERROR: Unexpected Deno version format: ${DENO_VERSION}"
  exit 1
fi

# Maps a MAJOR.MINOR.PATCH version to a single integer for range comparison.
# Components are read as base-10 and must be below 1000.
version_num() {
  local major minor patch
  IFS='.' read -r major minor patch <<<"$1"
  echo $(( (10#${major} * 1000 + 10#${minor}) * 1000 + 10#${patch} ))
}

if (( $(version_num "${DENO_VERSION}") < $(version_num "${DENO_VERSION_MIN}") ||
      $(version_num "${DENO_VERSION}") >= $(version_num "${DENO_VERSION_MAX}") )); then
  echo "ERROR: Deno version is ${DENO_VERSION}, expected >= ${DENO_VERSION_MIN} and < ${DENO_VERSION_MAX}."
  exit 1
fi

if [[ "${DENO_VERSION}" != "${DENO_VERSION_PINNED}" ]]; then
  if [[ "${DENO_CHECK_VERSION_LENIENT:-}" == '' ]]; then
    echo "ERROR: Deno version is ${DENO_VERSION}; this repository pins ${DENO_VERSION_PINNED} (mise.toml)."
    echo "ERROR: An off-pin toolchain can pass code the pin refuses, and refuse code the pin passes."
    echo "ERROR: Install the pin with mise <https://mise.jdx.dev/> and 'mise install', then run"
    echo "ERROR: 'mise exec -- deno task check'; or set DENO_CHECK_VERSION_LENIENT=1 to accept"
    echo "ERROR: an off-pin verdict."
    exit 1
  fi
  echo "WARNING: Deno version is ${DENO_VERSION}; this repository pins ${DENO_VERSION_PINNED} (mise.toml)."
  echo "WARNING: DENO_CHECK_VERSION_LENIENT is set, so the check runs anyway."
  # Repeated when the run ends, pass or fail: the lines above scroll away
  # behind one Check line per module, and the verdict's provenance belongs
  # next to the verdict.
  version_mismatch_reminder() {
    echo "WARNING: This check ran under Deno ${DENO_VERSION}, not the pinned ${DENO_VERSION_PINNED}."
  }
  trap version_mismatch_reminder EXIT
fi

# The checked path list and the per-package invocations live in
# tasks/typecheck.ts; this script owns only the version gate above. Each
# package group is its own timed, recorded typecheck-kind test.
deno run --allow-read --allow-write --allow-env --allow-run \
  tasks/typecheck.ts "$@"
