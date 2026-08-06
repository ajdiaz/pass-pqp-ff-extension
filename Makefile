VERSION ?= $(shell cat .version 2>/dev/null || echo 0.1.0)
NAME := pass-pqp-ff-extension
HOST_NAME := pass_pqp_host
EXTENSION_ID := pass-pqp@localhost

PREFIX ?= /usr/local
HOST_DIR := $(PREFIX)/lib/$(NAME)
FIREFOX_NATIVE_DIR := $(HOME)/.mozilla/native-messaging-hosts
LIBREWOLF_NATIVE_DIR := $(HOME)/.librewolf/native-messaging-hosts

.PHONY: all build install install-host install-manifest uninstall uninstall-host \
	uninstall-manifest uninstall-dist write-manifest clean

all: build

#######################
# Packaging

build:
	rm -rf dist/$(NAME)
	mkdir -p dist/$(NAME)
	cp -r src/. dist/$(NAME)/
	(cd dist/$(NAME) && zip -qr ../$(NAME)-$(VERSION).zip .)
	@echo "Built dist/$(NAME)-$(VERSION).zip"

#######################
# Native host installation

install: install-host install-manifest

install-host:
	install -d $(HOST_DIR)
	install -m 0755 native/pass-pqp-host.sh $(HOST_DIR)/pass-pqp-host.sh
	@echo "Installed native host: $(HOST_DIR)/pass-pqp-host.sh"

install-manifest: install-manifest-firefox install-manifest-librewolf

install-manifest-firefox:
	install -d $(FIREFOX_NATIVE_DIR)
	$(MAKE) --no-print-directory write-manifest DEST=$(FIREFOX_NATIVE_DIR)

install-manifest-librewolf:
	install -d $(LIBREWOLF_NATIVE_DIR)
	$(MAKE) --no-print-directory write-manifest DEST=$(LIBREWOLF_NATIVE_DIR)

write-manifest:
	@sed \
		-e 's|__HOST_PATH__|$(HOST_DIR)/pass-pqp-host.sh|' \
		-e 's|__EXTENSION_ID__|$(EXTENSION_ID)|' \
		native/pass-pqp-host.json.in > $(DEST)/$(HOST_NAME).json
	@echo "Installed native manifest: $(DEST)/$(HOST_NAME).json"

#######################
# Uninstall

uninstall: uninstall-host uninstall-manifest uninstall-dist

uninstall-host:
	rm -f $(HOST_DIR)/pass-pqp-host.sh
	@dir="$(HOST_DIR)"; \
	while [ "$$dir" != "$(PREFIX)" ] && [ "$$dir" != "/" ] && [ "$$dir" != "$$HOME" ]; do \
		rmdir "$$dir" 2>/dev/null || break; \
		dir=$${dir%/*}; \
	done
	@echo "Removed $(HOST_DIR)/pass-pqp-host.sh"

uninstall-manifest:
	rm -f $(FIREFOX_NATIVE_DIR)/$(HOST_NAME).json
	rm -f $(LIBREWOLF_NATIVE_DIR)/$(HOST_NAME).json
	@echo "Removed native manifests"

uninstall-dist:
	rm -rf dist web-ext-artifacts
	@echo "Removed build artifacts (dist/, web-ext-artifacts/)"

clean:
	rm -rf dist web-ext-artifacts
