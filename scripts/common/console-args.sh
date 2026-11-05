#!/usr/bin/env bash
#
# The arguments `start-local-dev.sh` starts the cf-harness console with.
#
# Held apart from the script that uses it so that what a console is launched
# with can be asserted without bringing a fabric up: the launch site sits
# behind the toolshed and the shell coming up, so a test driving the whole
# script never reaches it, and a forwarding line deleted there would be
# invisible.

# Prints one console-launch argument per line, for the fabric described by its
# environment:
#
#   CONSOLE_PORT       the port the console binds
#   TOOLSHED_API_URL   the fabric it runs against
#   CONSOLE_STORE      the store that toolshed serves, as a path
#   LOOM_INSTANCE_ID   optional; the loom instance to read identity and space from
#   DB_PATH            optional; the toolshed's single-file store
#   CF_HARNESS_ALLOW_SKILL_SCRIPTS_FLAG
#                      `true` to let that console run skill scripts
#   CF_HARNESS_ALLOW_BROWSER_HOST_FLAG
#                      `true` to let a task declare a browser host
#
# `--allow-browser-host` and `--space-db` go after `--` because they are the
# console server's flags rather than the launcher's, and everything before
# `--` is the launcher's own.
console_launch_args() {
    printf '%s\n' --port "$CONSOLE_PORT"
    printf '%s\n' --fabric-api-url "$TOOLSHED_API_URL"
    if [[ -n "${LOOM_INSTANCE_ID:-}" ]]; then
        printf '%s\n' --instance "$LOOM_INSTANCE_ID"
    fi
    printf '%s\n' --store "$CONSOLE_STORE"
    if [[ "${CF_HARNESS_ALLOW_SKILL_SCRIPTS_FLAG:-false}" == "true" ]]; then
        printf '%s\n' --allow-skill-scripts
    fi
    local server_args=()
    if [[ "${CF_HARNESS_ALLOW_BROWSER_HOST_FLAG:-false}" == "true" ]]; then
        server_args+=(--allow-browser-host)
    fi
    if [[ -n "${DB_PATH:-}" ]]; then
        server_args+=(--space-db "$DB_PATH")
    fi
    if [[ ${#server_args[@]} -gt 0 ]]; then
        printf '%s\n' -- "${server_args[@]}"
    fi
}
