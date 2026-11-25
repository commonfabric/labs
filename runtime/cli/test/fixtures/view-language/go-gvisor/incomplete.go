package main

import (
    "fmt"
    "regexp"
    "strconv"
    "strings"
)

// imageRef is an image reference split the way a registry is asked for it.
type imageRef struct {
    // host is the registry's API host: docker.io's short names go to
    // registry-1.docker.io.
    host string

    // repo is the repository path, with docker.io's implicit `library/`.
    repo string

    // tag is the tag given, `latest` when neither a tag nor a digest is,
    // and empty when only a digest is.
    tag string

    // digest is the `sha256:<hex>` the reference pins, if it pins one.
    digest string
}

var (
    digestPattern    = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
    tagPattern       = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$`)
    componentPattern = regexp.MustCompile(`^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$`)
    // hostPattern is a registry host as an HTTPS URL takes it: DNS labels or
    // an IPv4 address, and an optional port. Anything else (a `?`, a `#`, a
    // userinfo, brackets) would change the URL the registry is asked at.
    hostPattern = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::([0-9]{1,5}))?$`)
)

// parseRef splits an image reference: `[host[:port]/]path[:tag][@sha256:hex]`.
// A first component with no `.` or `:` that is not `localhost` is part of a
// docker.io path, as `docker pull` reads it.
func parseRef(s string) (imageRef, error) {
    bad := func(why string) (imageRef, error) {
        return imageRef{}, fmt.Errorf("image reference %q %s", s, why)
    }
    if s == "" {
        return bad("is empty")
    }
    var r imageRef
    name := s
    if i := strings.Index(name, "@"); i >= 0 {
        r.digest = name[i+1:]
        name = name[:i]
        if !digestPattern.MatchString(r.digest) {
            return bad("names a digest that is not sha256:<64 lowercase hex>")
        }
    }
    if i := strings.LastIndex(name, ":"); i > strings.LastIndex(name, "/") {
        r.tag = name[i+1:]
        name = name[:i]
        if !tagPattern.MatchString(r.tag) {
            return bad("names a malformed tag")
        }
    }
    parts := strings.Split(name, "/")
    first := parts[0]
    if len(parts) > 1 && (strings.ContainsAny(first, ".:") || first == "localhost") {
        m := hostPattern.FindStringSubmatch(first)
        if m == nil {
            return bad(fmt.Sprintf("names a malformed registry host %q", first))
        }
        if m[1] != "" {
            if port, _ := strconv.Atoi(m[1]); port <