#!/bin/bash
# Build tuturu container image
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-tuturu}"
IMAGE_TAG="${IMAGE_TAG:-local}"

echo "Building ${IMAGE_NAME}:${IMAGE_TAG}..."

podman build \
    -t "${IMAGE_NAME}:${IMAGE_TAG}" \
    -f container/Dockerfile \
    .

echo "Build complete: ${IMAGE_NAME}:${IMAGE_TAG}"
