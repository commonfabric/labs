# The `cf` command the CLI walkthroughs and demos run, as the array `CF`.
# Sourced, not executed.
#
# Usage, after any `cd` that chooses where `cf` runs:
#
#   source "$SCRIPT_DIR/cf-launcher.sh"
#   "${CF[@]}" id new
#
# `CF_BINARY` names whatever `cf` the harness supplies: a source launcher
# such as `bin/cf`, or a built binary. When it is unset or empty, `CF` falls
# back to running this checkout's CLI from source through the checkout's `cf`
# task. `CF` is an array so a caller can hand it to another program as part
# of an argument list, and so a path holding whitespace stays one word.
#
# The fallback names the directory `cf` runs in, because the launcher would
# otherwise take an inherited `INIT_CWD` in preference to it. `deno task` sets
# `INIT_CWD` only where it is not already set, so under an enclosing
# `deno task` it names wherever that one started. The directory is the one
# current when this file is sourced, which is why a script sources it after
# any `cd` and changes directory no further.

if [ -n "${CF_BINARY:-}" ]; then
  CF=("$CF_BINARY")
else
  CF=(deno task --quiet
    --cwd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
    cf --cwd "$PWD" --)
fi
