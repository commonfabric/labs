package agent

import (
    "context"
    "crypto/rand"
    "crypto/sha1"
    "encoding/binary"
    "encoding/hex"
    "errors"
    "fmt"
    "log/slog"
    "maps"
    "os"
    "slices"
    "strings"
    "sync"
    "time"

    "cloud.google.com/go/compute/apiv1/computepb"
    corev1 "k8s.io/api/core/v1"
    kerrors "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/client-go/kubernetes"
)

type RecoveryCleaner struct {
    dm     *DatasetManager
    lm     *LeaseManager
    gcs    manifestStore
    gce    recoveryGCE
    k8s    kubernetes.Interface
    waiter func(context.Context, string, time.Duration) error
    nodeID string
    log    *slog.Logger
    // quiesce, when set (SetQuiescence), gates each acquired drain fence
    // on LOCAL predecessor quiescence before destructive work — the
    // same-node successor-quiescence handoff (independent review pass 2:
    // acquisition is a reservation, not a usable destruction grant).
    quiesce func(ctx context.Context, datasetID string) error
    // shared holds process-wide cleaner state behind a pointer: the
    // recovery device's in-process ownership mutex. NewRecoveryCleaner
    // allocates it, and a cleaner copied from a constructed one (a test
    // builds one per DatasetManager) shares it; a hand-built literal gets
    // its own, lazily, under a package mutex.
    shared *cleanerShared
    // publishBudget, when set, replaces publishBudgetFor's result. Set by
    // tests.
    publishBudget time.Duration
    // diskRecordProtocol is a deployment version-floor gate. Empty retains
    // the legacy protocol until all pre-issue75 recovery writers are stopped.
    diskRecordProtocol string
}

// cleanerShared: see RecoveryCleaner.shared.
type cleanerShared struct {
    // deviceMu serializes every step that occupies or vacates the
    // zfs-recovery device name in this process (pass 6, Q6-3): a stale
    // reclaim's export/detach and a new run's reclaim/attach/import
    // cannot interleave, so a sampled attachment cannot be detached out
    // from under a run that replaced it. Across PROCESSES the exclusion
    // is the durable device lease, held by a deviceSpan. (An unresolved
    // operation's memory is NOT here: it is scoped to the LeaseManager,
    // the admission identity — pass 9, Q9-4; see deviceMemory.)
    deviceMu sync.Mutex
}

var cleanerSharedMu sync.Mutex

func (rc *RecoveryCleaner) sharedState() *cleanerShared {
    cleanerSharedMu.Lock()
    defer cleanerSharedMu.Unlock()
    if rc.shared == nil {
        rc.shared = &cleanerShared{}
    }
    return rc.shared
}
