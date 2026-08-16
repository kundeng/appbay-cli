# Appbay development shortcuts

.PHONY: build test dev cli init doctor up down clean docker help dev-env

# Build everything
build:
	pnpm turbo build

# Verify the local dev environment (OrbStack VM up, appbay + podman + Caddy edge healthy)
dev-env:
	bash scripts/dev-env.sh

# Run all tests
test:
	pnpm turbo test

# Start dev server (with auth bypass).
# Guarded because this Makefile is shared verbatim with the open-core upstream, which has
# no apps/web — see .kiro/specs/appbay-v1/S27-open-core-split/spec.md. A target that fails
# with "No such file" upstream reads as a broken build; this says what is actually true.
dev:
	@if [ -d apps/web ]; then \
		APPBAY_DEV_AUTH=true pnpm --filter @appbay/web dev; \
	else \
		echo "The web control plane is not part of this repository."; \
		echo "Run it as a container instead:  appbay server start"; \
		exit 1; \
	fi

# Build CLI binary
cli:
	pnpm --filter @appbay/cli build

# Initialize local dev environment
init:
	./apps/cli/dist/appbay init

# Run doctor checks
doctor:
	./apps/cli/dist/appbay doctor

# Deploy an app (usage: make up APP=whoami)
up:
	./apps/cli/dist/appbay up $(APP)

# Stop an app (usage: make down APP=whoami)
down:
	./apps/cli/dist/appbay down $(APP)

# Build Docker image (see the note on `dev` for why this is guarded)
docker:
	@if [ -f apps/web/Dockerfile ]; then \
		docker build -t appbay/server:dev -f apps/web/Dockerfile .; \
	else \
		echo "The web control-plane image is built from apps/web, which is not part of"; \
		echo "this repository. Pull the published image instead:"; \
		echo "  docker pull ghcr.io/kundeng/appbay-server:latest"; \
		exit 1; \
	fi

# Run Docker container
docker-run:
	docker run --rm -d --name appbay-server -p 3000:3000 \
		-v $${APPBAY_HOME:-$$HOME/.appbay}:/home/appbay/.appbay \
		-e APPBAY_HOME=/home/appbay/.appbay \
		-e APPBAY_DEV_AUTH=true \
		appbay/server:dev

# Clean build artifacts
clean:
	rm -rf apps/cli/dist/ packages/core/dist/ packages/db/dist/ apps/web/.next/ .turbo/

# Type check without emitting
typecheck:
	pnpm turbo typecheck

# Show help
help:
	@echo "Appbay development commands:"
	@echo "  make build       Build all packages"
	@echo "  make test        Run all tests"
	@echo "  make dev         Start dev server (auth bypass)"
	@echo "  make cli         Build CLI binary"
	@echo "  make init        Initialize ~/.appbay"
	@echo "  make doctor      Check prerequisites"
	@echo "  make up APP=x    Deploy an app"
	@echo "  make down APP=x  Stop an app"
	@echo "  make docker      Build Docker image"
	@echo "  make docker-run  Run Docker container"
	@echo "  make clean       Clean build artifacts"
	@echo "  make typecheck   Type check all packages"
