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
    s.prompt = 