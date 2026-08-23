VERSION ?= $(shell cat .version 2>/dev/null || echo 0.1.0)
NAME := pass-pqp-ff-extension
HOST_NAME := pass_pqp_host
# Local development ID. AMO rejects "@localhost" IDs for signing, so the
# sign/publish targets substitute AMO_EXTENSION_ID into a release manifest.
EXTENSION_ID ?= pass-pqp@localhost

PREFIX ?= /usr/local
HOST_DIR := $(PREFIX)/lib/$(NAME)
FIREFOX_NATIVE_DIR := $(HOME)/.mozilla/native-messaging-hosts
LIBREWOLF_NATIVE_DIR := $(HOME)/.librewolf/native-messaging-hosts

# ---- AMO signing & publishing --------------------------------------
#
# Sign the extension with Mozilla's AMO service and publish it on
# addons.mozilla.org. Requirements:
#   - web-ext:      npm install --global web-ext
#   - API keys:     https://addons.mozilla.org/developers/addon/api/key/
#                   export AMO_API_KEY="user:..." AMO_API_SECRET="..."
#   - AMO_EXTENSION_ID: the permanent extension ID AMO assigns. AMO does
#                   not sign "@localhost" IDs, so choose a stable one
#                   (e.g. pass-pqp@ajdiaz.me) BEFORE the first submission.
#                   AMO creates the add-on under that ID and reuses it for
#                   every later release. After signing, install the native
#                   host with EXTENSION_ID=$(AMO_EXTENSION_ID) so the
#                   allowed_extensions entry matches.
#
#   make sign       # private, signed .xpi (channel: unlisted)
#   make publish    # submit to addons.mozilla.org for review/listing

AMO_API_KEY ?=
AMO_API_SECRET ?=
AMO_EXTENSION_ID ?=
AMO_CHANNEL ?= unlisted
AMO_EXTRA_ARGS ?=
WEB_EXT ?= web-ext
SIGN_DIR := dist/release

.PHONY: all build install install-host install-manifest uninstall uninstall-host \
	uninstall-manifest uninstall-dist write-manifest clean \
	release-manifest sign publish

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
# AMO signing & publishing

release-manifest:
	@test -n "$(AMO_EXTENSION_ID)" || \
		{ echo "error: set AMO_EXTENSION_ID (e.g. pass-pqp@ajdiaz.me)"; exit 1; }
	@test -n "$(shell command -v $(WEB_EXT) 2>/dev/null)" || \
		{ echo "error: $(WEB_EXT) not found (npm install --global web-ext)"; exit 1; }
	@rm -rf $(SIGN_DIR)
	@mkdir -p $(SIGN_DIR)
	@cp -r src/. $(SIGN_DIR)/
	@sed -i "s/pass-pqp@localhost/$(AMO_EXTENSION_ID)/" $(SIGN_DIR)/manifest.json
	@echo "Prepared release manifest with extension ID: $(AMO_EXTENSION_ID)"

sign: release-manifest
	@test -n "$(AMO_API_KEY)" || { echo "error: set AMO_API_KEY"; exit 1; }
	@test -n "$(AMO_API_SECRET)" || { echo "error: set AMO_API_SECRET"; exit 1; }
	$(WEB_EXT) sign \
		--source-dir $(SIGN_DIR) \
		--artifacts-dir web-ext-artifacts \
		--api-key "$(AMO_API_KEY)" \
		--api-secret "$(AMO_API_SECRET)" \
		--channel $(AMO_CHANNEL) \
		$(AMO_EXTRA_ARGS)
	@echo "Signed $(NAME)-$(VERSION).xpi (channel: $(AMO_CHANNEL))"
	@echo "Install the native host with EXTENSION_ID=$(AMO_EXTENSION_ID)"

publish:
	$(MAKE) --no-print-directory sign AMO_CHANNEL=listed
	@echo "Submitted $(NAME)-$(VERSION) to addons.mozilla.org for review."

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
