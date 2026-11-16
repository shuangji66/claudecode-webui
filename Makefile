# Makefile：前端打包 → 拷入 embed → 编译成单个自包含二进制。
#
#   make                 # 开发构建（默认，不裁剪符号）
#   make release V=1.0.0 # 发布构建（-s -w + 外部链接），版本号注入 main.version
#   make test            # 后端 go test + 前端 vitest
#   make clean           # 清理产物（并把 embed 里的占位 index.html 还原）
#
# 部署约定：只部署 ccweb 本身；claude 由「设置 → 部署」按版本下载到数据目录，
# 不再随包分发、也不回退 PATH。服务只监听 unix socket，由网关按 baseurl 前缀反代。

ROOT     := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
BACKEND  := $(ROOT)/backend
FRONTEND := $(ROOT)/frontend
EMBED    := $(BACKEND)/internal/webui/embed
OUT      := $(ROOT)/bin/ccweb

V        ?= 0.1.0

# 项目本地 Go 缓存：宿主机的 GOCACHE 往往不可写。
GOCACHE    ?= $(ROOT)/.gocache
GOMODCACHE ?= $(ROOT)/.gomodcache
export GOCACHE GOMODCACHE
export GOFLAGS := -buildvcs=false
export npm_config_cache ?= $(ROOT)/.npmcache

.PHONY: all dev release build frontend test test-backend test-frontend vet fmt clean

.NOTPARALLEL:

all: dev

dev: ## 开发构建
	$(MAKE) build LDFLAGS="-X main.version=$(V)"

release: ## 发布构建
	$(MAKE) build LDFLAGS="-s -w -X main.version=$(V)"

frontend:
	@echo "==> 构建前端"
	cd "$(FRONTEND)" && npm install --no-audit --no-fund && npm run build

build: frontend
	@echo "==> 拷贝前端产物到 embed"
	rm -rf "$(EMBED)"
	mkdir -p "$(EMBED)"
	cp -r "$(FRONTEND)"/dist/. "$(EMBED)"/
	@echo "==> 编译后端"
	mkdir -p "$(GOCACHE)" "$(GOMODCACHE)" "$(ROOT)/bin"
	cd "$(BACKEND)" && go build -trimpath -ldflags "$(LDFLAGS)" -o "$(OUT)" ./cmd/ccweb
	@echo "==> 完成：$(OUT)"
	@ls -lh "$(OUT)"

test: test-backend test-frontend

test-backend:
	cd "$(BACKEND)" && go test -timeout 120s ./...

test-frontend:
	cd "$(FRONTEND)" && npx vitest run

vet:
	cd "$(BACKEND)" && go vet ./...

fmt:
	cd "$(BACKEND)" && gofmt -w .

clean:
	# 只删构建产物 ccweb；bin/ 里还可能有部署时放进来的 claude，不能整目录删。
	rm -f "$(OUT)"
	rm -rf "$(EMBED)/assets"
	git -C "$(ROOT)" checkout -- "$(EMBED)" 2>/dev/null || true
