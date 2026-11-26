package describe

import (
    "context"
    "errors"
    "path/filepath"
    "strings"
    "testing"
    "time"
    "unicode/utf8"

    "github.com/commonfabric/bay/internal/config"
    "github.com/commonfabric/bay/internal/manifest"
    "github.com/commonfabric/bay/internal/transcript"
)

type stubSummarizer struct {
    calls  int
    out    string
    err    error
    prompt string
}

func (s *stubSummarizer) Summarize(_ context.Context, prompt string) (string, error) {
    s.calls++
    s.prompt = prompt
    return s.out, s.err
}

func writeManifest(t *testing.T, path string, bay manifest.Bay) {
    t.Helper()
    m := manifest.New()
    m.Docks = append(m.Docks, manifest.Dock{Name: "labs", Path: "/repo", Bays: []manifest.Bay{bay}})
    if err := manifest.Save(path, m); err != nil {
        t.Fatal(err)
    }
}
