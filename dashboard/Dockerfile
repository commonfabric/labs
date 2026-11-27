# Dev/company dashboard image — serves dashboard over HTTP.
#
# Build context is the labs repo ROOT: the "/bench?view=gantt" drill-down shells
# out to scripts/ci-gantt.ts, so the repo source must be in the image (modeled on
# runtime/toolshed/Dockerfile). Every backend is reached over its REST API — the GitHub
# tiles as a GitHub App or with GH_TOKEN, and the cloud-spend tile via BigQuery
# using the workload's own service account (Workload Identity) — so no cloud CLI
# is installed. The one exception is the ci tile's offcuts scan, which fetches
# repositories over Git.
#
# The GKE nodes are linux/amd64, so the image is pinned to that platform. Build
# it on any host — an Apple-Silicon Mac emulates amd64 through QEMU:
#
#   docker build --platform=linux/amd64 -f dashboard/Dockerfile \
#     --build-arg DASHBOARD_GIT_COMMIT=$(git rev-parse HEAD) \
#     -t us-central1-docker.pkg.dev/commontools-core/containers/dev-dashboard:$(git rev-parse HEAD) .

FROM --platform=linux/amd64 denoland/deno:2.9.8@sha256:a0d88a7fcbd44f062cba2748e19df67d30290ad12aa203c7c1e0b12462c483f0

# The ci tile's scan for references into the offcuts organization keeps each
# repository as a shallow Git repository and searches it with `git grep`.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

ARG DASHBOARD_GIT_COMMIT
ENV DASHBOARD_GIT_COMMIT=${DASHBOARD_GIT_COMMIT}
RUN printf '%s\n' "${DASHBOARD_GIT_COMMIT}" | grep -Eq '^[0-9a-f]{40}$'

# Pre-fetch the dashboard's and Gantt renderer's dependencies, then make the
# cache writable by the non-root runtime user.
ENV DENO_DIR=/deno-dir
RUN deno cache dashboard/server.ts scripts/ci-gantt.ts \
    && chown -R 65532:65532 /deno-dir

USER 65532
ENV DASHBOARD_PORT=8731
EXPOSE 8731
ENTRYPOINT ["deno", "run", \
  "--allow-net", "--allow-run=deno,git", "--allow-read", "--allow-write", "--allow-env", \
  "dashboard/server.ts"]
