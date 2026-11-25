package main

import (
    "context"
    "errors"
    "fmt"
    "log/slog"
    "net/http"
    "os"
    "os/signal"
    "strconv"
    "syscall"
    "time"

    "github.com/commontoolsinc/sandbox-runner/internal/runner"
)

func main() {
    logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
    slog.SetDefault(logger)

    ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer cancel()

    if err := run(ctx, logger); err != nil {
        logger.Error("fatal", "err", err)
        os.Exit(1)
    }
}

func run(ctx context.Context, logger *slog.Logger) error {
    httpAddr := ":" + envOr("RUNNER_HTTP_PORT", "8081")
    sandboxURL := envOr("SANDBOX_API_URL", "http://127.0.0.1:8080")
    workers := envIntOr("RUNNER_WORKERS", 2)
    queueSize := envIntOr("RUNNER_QUEUE_SIZE", 256)

    client := runner.NewHTTPSandboxClient(sandboxURL, nil)
    service := runner.NewService(client, workers, queueSize, logger.With("component", "service"))
    service.Start(ctx)

    httpServer := &http.Server{
        Addr:         httpAddr,
        Handler:      runner.NewHTTPServer(service).Handler(),
        ReadTimeout:  10 * time.Second,
        WriteTimeout: 5 * time.Minute,
    }

    errCh := make(chan error, 1)
    go func() {
        logger.Info("starting sandbox-runner", "addr", httpAddr, "sandboxApi", sandboxURL, "workers", workers)
        if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
            errCh <- fmt.Errorf("http server: %w", err)
        }
    }()

    select {
    case <-ctx.Done():
        logger.Info("shutdown requested")
    case err := <-errCh:
        return err
    }

    shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()
    _ = httpServer.Shutdown(shutdownCtx)

    service.Wait()
    return nil
}

func envOr(key, fallback string) string {
    v := os.Getenv(key)
    if v == "" {
        return fallback
    }
    return v
}

func envIntOr(key string, fallback int) int {
    v := os.Getenv(key)
    if v == "" {
        return fallback
    }
    n, err := strconv.Atoi(v)
    if err != nil || n <= 0 {
        return fallback
    }
    return n
}
