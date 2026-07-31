#!/usr/bin/env bash
#
# Builds the device release bundle: an arm64 tarball carrying the compiled server, the two
# UIs, node_modules built for the Pi, a matching Node runtime and the installer.
#
#   ./scripts/build-release.sh                    # -> release/kids-messenger-<version>-linux-arm64.tar.gz
#   ./scripts/build-release.sh --output /tmp/out
#
# Docker does the work (see packaging/Dockerfile.release) because the Pi must never
# compile anything and a macOS node_modules tree is the wrong architecture anyway.
#
# On an Apple Silicon or arm64 Linux host this builds natively. On an x86 host it runs
# under QEMU, which works but is slow — install the emulators first:
#   docker run --privileged --rm tonistiigi/binfmt --install arm64
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

# shellcheck source=../packaging/versions.env
source packaging/versions.env

OUTPUT_DIR="${REPO_ROOT}/release"
PLATFORM="${TARGET_PLATFORM}"

usage() {
  cat <<'EOF'
Builds the device release tarball with Docker.

Usage: ./scripts/build-release.sh [options]

Options:
  --output DIR      Where to write the tarball (default: ./release)
  --platform P      Docker platform to build for (default: linux/arm64)
  -h, --help        This message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) OUTPUT_DIR="$2"; shift 2 ;;
    --platform) PLATFORM="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not installed"
docker info >/dev/null 2>&1 || die "the Docker daemon is not reachable — start Docker Desktop / OrbStack and retry"

APP_VERSION="$(node -p "require('./package.json').version")"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
if ! git diff --quiet HEAD 2>/dev/null; then
  GIT_SHA="${GIT_SHA}-dirty"
fi
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Last commit time rather than "now", so a rebuild of the same tree is byte-identical.
SOURCE_DATE_EPOCH="$(git log -1 --format=%ct 2>/dev/null || echo 0)"

ARCH="${PLATFORM##*/}"
ARTIFACT="kids-messenger-${APP_VERSION}-linux-${ARCH}.tar.gz"

# Captured rather than piped into grep: `grep -q` exits at the first match, docker takes a
# SIGPIPE, and `set -o pipefail` then reports the whole check as failed.
BUILDER_INFO="$(docker buildx inspect --bootstrap 2>/dev/null || true)"
if [[ "${BUILDER_INFO}" != *"${PLATFORM}"* ]]; then
  cat >&2 <<EOF
error: this Docker builder cannot build ${PLATFORM}.
       On an x86 host, install the QEMU emulators once:
         docker run --privileged --rm tonistiigi/binfmt --install ${ARCH}
EOF
  exit 1
fi

echo "==> building ${ARTIFACT}"
echo "    version   ${APP_VERSION} (${GIT_SHA})"
echo "    platform  ${PLATFORM}"
echo "    base      ${NODE_IMAGE}"
echo "    target    ${TARGET_OS}"
echo

mkdir -p "${OUTPUT_DIR}"

docker buildx build \
  --file packaging/Dockerfile.release \
  --platform "${PLATFORM}" \
  --target artifact \
  --build-arg "NODE_IMAGE=${NODE_IMAGE}" \
  --build-arg "BUILD_PACKAGES=${BUILD_PACKAGES}" \
  --build-arg "APP_VERSION=${APP_VERSION}" \
  --build-arg "GIT_SHA=${GIT_SHA}" \
  --build-arg "BUILD_DATE=${BUILD_DATE}" \
  --build-arg "TARGET_OS=${TARGET_OS}" \
  --build-arg "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}" \
  --output "type=local,dest=${OUTPUT_DIR}" \
  .

[[ -f "${OUTPUT_DIR}/${ARTIFACT}" ]] || die "the build produced no ${ARTIFACT}"

# Verify the checksum the builder wrote, so a truncated export is caught here rather than
# halfway through an install on the device.
if command -v sha256sum >/dev/null 2>&1; then
  ( cd "${OUTPUT_DIR}" && sha256sum -c "${ARTIFACT}.sha256" )
else
  ( cd "${OUTPUT_DIR}" && shasum -a 256 -c "${ARTIFACT}.sha256" )
fi

SIZE="$(du -h "${OUTPUT_DIR}/${ARTIFACT}" | cut -f1)"
echo
echo "==> ${OUTPUT_DIR}/${ARTIFACT} (${SIZE})"
echo
echo "Next:"
echo "  ./scripts/smoke-test-release.sh                 # boot it in a bare ${TARGET_ARCH} container"
echo "  scp ${OUTPUT_DIR}/${ARTIFACT} pi@kids-messenger.local:"
echo "  ssh pi@kids-messenger.local 'tar xzf ${ARTIFACT} && sudo ./kids-messenger-${APP_VERSION}-linux-${ARCH}/install.sh'"
