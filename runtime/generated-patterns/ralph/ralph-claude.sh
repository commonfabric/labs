#!/usr/bin/env bash
while :; do
  cat runtime/generated-patterns/ralph/prompt.md | \
  claude --print --dangerously-skip-permissions \
  --verbose --output-format=stream-json 2&>1 | \
  tee -a ~/ralph-claude.log
  if [[ -n "$(git status --porcelain)" ]]; then
    git add -A
    msg="$(
    llm "Summarize these changes into a short one-line description, \
output just that one line: $(git diff --staged)"
    )"
    git stash push -m "$msg"
  fi
done
echo "Stopped because the command failed."

