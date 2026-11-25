FROM golang:1.25-bookworm AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /node-agent ./cmd/node-agent
RUN CGO_ENABLED=0 go build -o /csi-controller ./cmd/csi-controller

FROM debian:bookworm-slim

# Install ZFS utilities (zfsutils-linux is in contrib)
RUN echo "deb http://deb.debian.org/debian bookworm contrib" >> /etc/apt/sources.list.d/contrib.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        zfsutils-linux \
        parted \
        ca-certificates \
        iproute2 \
        iptables \
        bzip2 \
        wget && \
    rm -rf /var/lib/apt/lists/*

# Official release bundle: upstream no longer publishes standalone binaries.
# Keep gvisor-bin beside runsc; its sidecars are needed at runtime.
# Release/checksum evidence: docs/gvisor-image-release.md.
RUN ARCH=$(uname -m) && \
    case "$ARCH" in \
      x86_64) SHA256=94a1b9716797efcb0b348fc3283ddaa1ee5c7898b61eeccb08ee9ac7dc903c15 ;; \
      aarch64) SHA256=218cef646c1c04a62d9acb988127e6da7c4f9e5aaefeef6929893df7a349ecb9 ;; \
      *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;; \
    esac && \
    wget -q "https://github.com/google/gvisor/releases/download/release-20260914.0/gvisor-${ARCH}.tar.bz2" -O /tmp/gvisor.tar.bz2 && \
    echo "$SHA256  /tmp/gvisor.tar.bz2" | sha256sum -c - && \
    tar -xjf /tmp/gvisor.tar.bz2 -C /usr/local/bin && \
    rm /tmp/gvisor.tar.bz2

COPY --from=builder /node-agent /usr/local/bin/node-agent
COPY --from=builder /csi-controller /usr/local/bin/csi-controller

ENTRYPOINT ["/usr/local/bin/node-agent"]
