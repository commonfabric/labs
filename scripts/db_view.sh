#!/usr/bin/env bash
# Sample call that views cell of:...s4ia in space did:key:...Ntos and 
# uses jq to select the property at value.argument:
# $> db_view Ntos s4ia | jq .value.argument
# This can be run from anywhere within the labs git repo.
# Use -a to get all the results, instead of just the last.
db_view() {
  local mode="last"
  local space
  local cell

  # Parse arguments
  if [[ "$1" == "--all" || "$1" == "-a" ]]; then
    mode="all"
    space=$2
    cell=$3
  else
    space=$1
    cell=$2
  fi

  if [[ -z "$space" || -z "$cell" ]]; then
    echo "Usage: db_view [--all|-a] <space> <cell>" >&2
    return 1
  fi
  
  local repo_root
  repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "Error: not in a git repo" >&2; return 1; }
  local db_file=$(find "$repo_root/runtime/toolshed/cache/memory/" -maxdepth 1 -name "did:key:*$space.sqlite" -print -quit)
  
  if [[ -z "$db_file" ]]; then
    echo "Error: Database file not found for space '$space'" >&2
    return 1
  fi

  local query
  if [[ "$mode" == "last" ]]; then
    query="SELECT datum.source
             FROM datum, memory, fact 
            WHERE memory.of LIKE '%$cell' 
              AND memory.fact = fact.this
              AND fact.\`is\` = datum.this"
  else
    query="SELECT datum.source FROM datum, fact 
            WHERE fact.of LIKE '%$cell' 
              AND fact.\`is\` = datum.this"
  fi

  sqlite3 "file:$db_file?mode=ro" "$query"
}

# If script is executed (not sourced), call the function with arguments
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  db_view "$@"
fi