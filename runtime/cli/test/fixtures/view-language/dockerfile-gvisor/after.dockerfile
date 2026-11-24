ARG BASE_IMAGE=ubuntu:22.04
FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:stable@sha256:3420fac28ac21d59623b5efbb57bd60c0a5c4223ad6cb604840080a8778679ee AS gcloud
FROM $BASE_IMAGE

ENV DEBIAN_FRONTEND="noninteractive"

#-------------------------------------------------------------------------------
# Note: If you want to use bazel directly you will need these packages or their
#       equivalents for your distribution:
#-------------------------------------------------------------------------------
RUN apt-get update && apt-get install -y curl gnupg2 git \
        python-is-python3 python3 python3-setuptools python3-pip \
        build-essential crossbuild-essential-arm64 qemu-user-static \
        openjdk-11-jdk-headless zip unzip \
        apt-transport-https ca-certificates gnupg-agent \
        software-properties-common \
        pkg-config libffi-dev patch diffutils libssl-dev iptables kmod \
        clang crossbuild-essential-amd64 erofs-utils busybox-static libbpf-dev \
        iproute2 netcat-openbsd libnuma-dev && \
    dpkg --compare-versions "$(dpkg-query -W -f='${Version}' ca-certificates)" ge '20260816ubuntu0.22.04.1'

# Synchronize Java's separate store as well as pip's vendored Python roots.
RUN mkdir -p /var/lib/ca-certificates-java && \
    touch /var/lib/ca-certificates-java/fresh && \
    dpkg-reconfigure ca-certificates-java && \
    PIP_BREAK_SYSTEM_PACKAGES=1 python3 -m pip install --upgrade 'pip==26.2.2' 'certifi==2026.10.19'

# This package is needed to build eBPF on amd64, but not on arm64 where it
# doesn't exist.
RUN test "$(uname -m)" != x86_64 && exit 0 || apt-get install -y libc6-dev-i386
#-------------------------------------------------------------------------------
# The rest of the file is unnecessary for building `runsc`, but are necessary
# for test targets.
#-------------------------------------------------------------------------------

# Install Docker client for the website build.
RUN curl -fsSL https://download.docker.com/linux/ubuntu/gpg | apt-key add -
RUN add-apt-repository \
   "deb https://download.docker.com/linux/ubuntu \
   $(lsb_release -cs) \
   stable"
RUN apt-get -y install docker-ce-cli

# The SDK includes independent certifi, httplib2, botocore and gsutil bundles.
COPY --from=gcloud /usr/lib/google-cloud-sdk /google-cloud-sdk
RUN ln -s /google-cloud-sdk/bin/gcloud /usr/bin/gcloud

# Download the official bazel binary. The APT repository isn't used because there is not packages for arm64.
COPY bazelversion .
RUN ARCH="$(uname -m | sed s/aarch64/arm64/)" BAZEL_VERSION="$(cat ./bazelversion)" && \
    curl -fsSL https://releases.bazel.build/${BAZEL_VERSION}/release/bazel-${BAZEL_VERSION}-linux-${ARCH} -o /usr/local/bin/bazel && \
    chmod ugo+x /usr/local/bin/bazel
# Bazel uses an embedded JDK whose cacerts is independent of Ubuntu's Java.
# Use the synchronized system store for repository downloads on both arches.
RUN test -s /etc/ssl/certs/java/cacerts && \
    echo 'startup --host_jvm_args=-Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts' > /etc/bazel.bazelrc
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/bazel"]
