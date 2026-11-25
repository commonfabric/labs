load("//tools:defs.bzl", "default_platform", "go_library", "go_test", "most_shards", "platforms")

package(
    default_applicable_licenses = ["//:license"],
    licenses = ["notice"],
)

go_library(
    name = "container",
    srcs = [
        "cfc_result_sidecar.go",
        "container.go",
        "gofer_to_host_rpc.go",
        "hook.go",
        "state_file.go",
        "status.go",
    ],
    visibility = [
        "//runsc:__subpackages__",
        "//test:__subpackages__",
    ],
    deps = [
        "//pkg/abi/linux",
        "//pkg/cleanup",
        "//pkg/log",
        "//pkg/sentry/control",
        "//pkg/sentry/fsimpl/erofs",
        "//pkg/sentry/fsimpl/tmpfs",
        "//pkg/sentry/pgalloc",
        "//pkg/sighandling",
        "//pkg/sync",
        "//pkg/unet",
        "//pkg/urpc",
        "//runsc/boot",
        "//runsc/cgroup",
        "//runsc/config",
        "//runsc/console",
        "//runsc/donation",
        "//runsc/profile",
        "//runsc/sandbox",
        "//runsc/specutils",
        "//runsc/starttime",
        "@com_github_cenkalti_backoff//:go_default_library",
        "@com_github_gofrs_flock//:go_default_library",
        "@com_github_opencontainers_runtime_spec//specs-go:go_default_library",
        "@org_golang_x_sys//unix:go_default_library",
    ],
)

go_test(
    name = "cfc_result_sidecar_test",
    size = "small",
    srcs = ["cfc_result_sidecar_test.go"],
    library = ":container",
    deps = [
        "//runsc/config",
        "//runsc/sandbox",
        "//runsc/specutils",
        "@com_github_opencontainers_runtime_spec//specs-go:go_default_library",
    ],
)
