# Build and install `poker-lan` as a standalone executable: no Node or npm needed to run it.
#
#   make                 build bin/poker-lan for this machine
#   make install         build, then copy it to $(PREFIX)/bin   (default ~/.local/bin)
#   make uninstall       remove it again
#   make release         build executables for every platform into release/
#   make clean           remove build output
#
# Building needs Bun (https://bun.sh). If it isn't installed, `npx bun` is used instead.

PREFIX  ?= $(HOME)/.local
BINDIR  := $(DESTDIR)$(PREFIX)/bin
TARGETS := linux-x64 linux-arm64 darwin-x64 darwin-arm64

HAVE_BUN := $(shell command -v bun 2>/dev/null)
ifeq ($(HAVE_BUN),)
  BUN     := npx --yes bun@1
  INSTALL := npm ci
else
  BUN     := bun
  INSTALL := bun install
endif

SOURCES := $(shell find src -name '*.ts' -o -name '*.tsx' | grep -v '/generated/') \
           public/index.html $(wildcard public/people/*.webp) package.json

.PHONY: all build install uninstall release clean

all: build

build: bin/poker-lan

node_modules: package.json
	$(INSTALL)
	@touch node_modules

src/generated/assets.ts: public/index.html $(wildcard public/people/*.webp) package.json scripts/embed-assets.mjs
	$(BUN) scripts/embed-assets.mjs

bin/poker-lan: node_modules src/generated/assets.ts $(SOURCES) scripts/compile.ts
	$(BUN) scripts/compile.ts

install: bin/poker-lan
	mkdir -p "$(BINDIR)"
	install -m 755 bin/poker-lan "$(BINDIR)/poker-lan"
	@echo "Installed $(BINDIR)/poker-lan"
	@case ":$$PATH:" in *":$(PREFIX)/bin:"*) ;; *) echo "Note: add $(PREFIX)/bin to your PATH to run poker-lan from anywhere." ;; esac

uninstall:
	rm -f "$(BINDIR)/poker-lan"

release: node_modules src/generated/assets.ts
	$(BUN) scripts/compile.ts $(TARGETS)
	@ls -lh release/

clean:
	rm -rf bin release src/generated
