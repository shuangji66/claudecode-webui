#!/bin/bash
# 一键构建：前端 → embed → Go 单二进制。
#   ./build.sh                # 开发构建
#   ./build.sh release 1.0.0  # 发布构建并注入版本号
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-dev}"
VERSION="${2:-0.1.0}"

if [ "$MODE" = "release" ]; then
  make -C "$ROOT" release V="$VERSION"
else
  make -C "$ROOT" dev V="$VERSION"
fi
