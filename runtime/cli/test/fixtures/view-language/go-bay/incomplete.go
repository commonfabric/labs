package palette

import (
    "os/exec"
    "strings"

    "github.com/commonfabric/bay/internal/tmux"
)

// Hotkeys maps bay-command signatures (e.g., "bay shell --window") to the
// tmux key that currently invokes them. Live data, captured by running
// `tmux list-keys -T root` at palette startup. Using the live bindings —
// rather than the canonical table in internal/cli/setup.go — means the
// palette teaches whatever the user actually has configured, including
// their own rebindings.
type Hotkeys struct {
    byCmd map[string]string
}

// LoadHotkeys runs `tmux list-keys -T root` and returns the parsed map.
// Any failure (tmux not on PATH, non-zero exit, unreadable output) is
// swallowed — the palette just renders without annotations.
func LoadHotkeys() *Hotkeys {
    cmd := exec.Command("tmux", "list-keys", "-T", "root")
    out, err := cmd.Output()
    if err != nil {
        return &Hotkeys{byCmd: map[string]string{}}
    }
    return parseHotkeys(string(out))
}

// parseHotkeys extracts `bay ...` command signatures and their key bindings.
// A bind-key line looks like one of:
//
//    bind-key -T root M-p display-popup -w 80% -h 80% -E 'bay palette --split pane || true'
//    bind-key -n M-p run-shell 'bay shell --window || true'
//    bind-key -T root M-c if-shell -F "#{@bay-session-id}" { run-shell "bay new -q || true" } { send-keys M-c }
//
// The key is the token immediately after `-T <table>` or `-n`. The command
// is the quoted string at (or near) the end of the line; any trailing
// ` || true` is stripped. Bay scopes most of its bindings to the sessions
// it manages, so the third form is the common one: the palette annotates
// the key with what it does in a bay, which is the arm the conditional
// takes there.
func parseHotkeys(output string) *Hotkeys {
    h := &Hotkeys{byCmd: map[string]string{}}
    for line := range strings.SplitSeq(output, "\n") {
        line = strings.TrimSpace(line)
        if !strings.HasPrefix(line, "bind-key ") {
            continue
        }
        key := extractKey(line)
        if key == "" {
            continue
        }
        cmd := extractQuotedCommand(scopedCommand(line))
        if cmd == "" {
            continue
        }
        cmd = strings.TrimSpace(strings.TrimSuffix(cmd, "|| true"))
        if !strings.HasPrefix(cmd, "bay ") && cmd != "bay" {
            continue
        }
        // First binding wins if duplicates exist.
        if _, already := h.byCmd[cmd]; !already {
            h.byCmd[cmd] = key
        }
    }
    return h
}

// extractKey returns the keystroke token. Supports both current syntax
// (`bind-key -T <table> <key> ...`) and legacy (`bind-key -n <key> ...`).
func extractKey(line string) string {
    fields := strings.Fields(line)
    for i := 1; i < len(fields); i++ {
        switch fields[i] {
        case "-T":
            if i+2 < len(fields) {
                return fields[i+2]
            }
        case "-n":
            if i+1 < len(fields) {
                return fields[i+1]
            }
        }
    }
    return ""
}

// scopedCommand unwraps bay's session-scope conditional, returning the
// command the binding runs in a bay-managed session. Lines that aren't
// scoped come back unchanged.
func scopedCommand(line string) string {
    if then, ok := tmux.UnwrapSc