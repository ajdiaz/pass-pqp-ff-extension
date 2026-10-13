VERSION ?= $(shell cat .version 2>/dev/null || echo 0.1.0)
# Explicit version for `make bump` (defaults to the next patch version).
BUMP ?=
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
# AMO submission metadata. web-ext passes this JSON directly to the AMO
# API (spreading it into the request body and merging `version` under
# `{upload}`), so the `license` field must live at `version.license`.
# If AMO_METADATA is empty a default file is generated at
# $(SIGN_DIR)/amo-metadata.json carrying the license below.
AMO_METADATA ?=
AMO_LICENSE ?= MIT
AMO_CATEGORY ?= privacy-security
AMO_EXTRA_ARGS ?=
WEB_EXT ?= web-ext
SIGN_DIR := dist/release
AMO_METADATA_FILE := $(or $(AMO_METADATA),$(SIGN_DIR)/amo-metadata.json)

.PHONY: all build bump install install-host install-manifest uninstall uninstall-host \
	uninstall-manifest uninstall-dist write-manifest clean \
	release-manifest sign publish

all: build

#######################
# Packaging

build:
	@if [ -e dist ] && [ ! -w dist ]; then \
		echo "error: dist/ is not writable (owned by another user, e.g. root)."; \
		echo "       fix it with: sudo chown -R $$(id -u):$$(id -g) dist"; \
		exit 1; \
	fi
	rm -rf dist/$(NAME)
	mkdir -p dist/$(NAME)
	cp -r src/. dist/$(NAME)/
	(cd dist/$(NAME) && zip -qr ../$(NAME)-$(VERSION).zip .)
	@echo "Built dist/$(NAME)-$(VERSION).zip"

# Bump the extension version everywhere it is recorded (.version and
# src/manifest.json). AMO rejects an upload whose version already exists
# ("409 Version X already exists."), and both `make sign` and `make publish`
# consume a version, so run this before every submission.
#
#   make bump            # next patch version, e.g. 0.1.2 -> 0.1.3
#   make bump BUMP=0.2.0 # explicit version
bump:
	@v="$(BUMP)"; \
	if [ -z "$$v" ]; then \
		cur=$$(cat .version 2>/dev/null || echo 0.0.0); \
		major=$${cur%%.*}; rest=$${cur#*.}; minor=$${rest%%.*}; patch=$${rest##*.}; \
		v="$$major.$$minor.$$((patch + 1))"; \
	fi; \
	printf '%s' "$$v" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$$' || \
		{ echo "error: version must be x.y.z (got '$$v')"; exit 1; }; \
	printf '%s' "$$v" > .version; \
	sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$$v\"/" src/manifest.json; \
	echo "Bumped to $$v (.version and src/manifest.json)"
	@$(MAKE) --no-print-directory build

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
	@if [ -z "$(AMO_METADATA)" ]; then \
		printf '{\n  "version": {\n    "license": "%s"\n  },\n  "categories": {\n    "firefox": ["%s"]\n  }\n}\n' \
			"$(AMO_LICENSE)" "$(AMO_CATEGORY)" > "$(AMO_METADATA_FILE)"; \
	fi
	@echo "Prepared release manifest with extension ID: $(AMO_EXTENSION_ID)"
	@echo "AMO metadata: $(AMO_METADATA_FILE) (license: $(AMO_LICENSE))"

sign: release-manifest
	@test -n "$(AMO_API_KEY)" || { echo "error: set AMO_API_KEY"; exit 1; }
	@test -n "$(AMO_API_SECRET)" || { echo "error: set AMO_API_SECRET"; exit 1; }
	$(WEB_EXT) sign \
		--source-dir $(SIGN_DIR) \
		--artifacts-dir web-ext-artifacts \
		--api-key "$(AMO_API_KEY)" \
		--api-secret "$(AMO_API_SECRET)" \
		--channel $(AMO_CHANNEL) \
		--amo-metadata "$(AMO_METADATA_FILE)" \
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
