#!/bin/sh
#
# pass-pqp native messaging host for Firefox / LibreWolf.
#
# Bridges the WebExtension native messaging protocol (length-prefixed JSON
# over stdio) to the `pass-pqp` command line tool, exposing three actions:
#
#   {"action": "configure"}                 -> host/version/store information
#   {"action": "list"}                      -> every entry path in the store
#   {"action": "fetch", "file": "<entry>"}  -> decrypted contents of an entry
#
# Every request may carry an optional "config" object that overrides the
# environment-based defaults:
#
#   {"action": "list", "config": {
#       "passPqpBin": "/path/to/pass-pqp",
#       "pqpBin": "/path/to/pqp",
#       "passwordStoreDir": "/path/to/store",
#       "noPassphrase": true
#   }}
#
# `passPqpBin` may point at either the pass-pqp wrapper or the raw pqp CLI.
# The host probes the binary once and remembers the result: if the binary
# exposes a `decrypt` subcommand it is the raw pqp CLI and "fetch" decrypts
# the entry file directly (the decryption key is located in the keyring
# automatically); otherwise it is treated as the pass-pqp wrapper and "fetch"
# runs `show`. When the wrapper is used, `pqpBin` (optional) tells it where the
# raw pqp CLI lives; the browser environment usually does not have it on PATH.
#
# The store paths returned by "list" are relative to the password store root
# and have the `.pqp.enc` suffix stripped, e.g. "github.com/username".
#
# Configuration via environment variables:
#   PASS_PQP_BIN            path to the pass-pqp binary or the raw pqp CLI
#                           (default: pass-pqp)
#   PASS_PQP_PQP_BIN        path to the raw pqp CLI; exported to the pass-pqp
#                           wrapper so it can find pqp (default: unset)
#   PASSWORD_STORE_DIR      password store location (default: ~/.password-store)
#   PASS_PQP_NO_PASSPHRASE  pass "1" to decrypt without prompting for a
#                           passphrase (default: "1", requires keys that were
#                           created with --no-passphrase)
#
# Dependencies: POSIX sh, jq, pass-pqp (plus the tools pass-pqp needs).
#
# MIT License.
#

HOST_NAME="pass_pqp_host"
HOST_VERSION="0.1.0"

PASS_PQP_BIN="${PASS_PQP_BIN:-pass-pqp}"
# Path to the raw pqp CLI, exported to pass-pqp wrapper subprocesses. Empty
# means the wrapper falls back to `pqp` on PATH (fine when launched from a
# shell, usually not when launched by the browser).
PASS_PQP_PQP_BIN="${PASS_PQP_PQP_BIN:-}"
PREFIX="${PASSWORD_STORE_DIR:-$HOME/.password-store}"
PREFIX="${PREFIX%/}"
ENCFILE_SUFFIX=".pqp.enc"
export PASS_PQP_NO_PASSPHRASE="${PASS_PQP_NO_PASSPHRASE:-1}"
# Keep `pass-pqp` subprocesses pointed at the same store as this host.
export PASSWORD_STORE_DIR="$PREFIX"

# Environment-based defaults; per-message "config" overrides are layered on top
# of these and never persist between messages.
DEF_PASS_PQP_BIN="$PASS_PQP_BIN"
DEF_PASS_PQP_PQP_BIN="$PASS_PQP_PQP_BIN"
DEF_PREFIX="$PREFIX"
DEF_NO_PASSPHRASE="$PASS_PQP_NO_PASSPHRASE"

# Temporary files created by action handlers, removed on exit.
TMP_FILES=""
cleanup() {
	[ -n "$TMP_FILES" ] && rm -f $TMP_FILES
}
trap cleanup EXIT

# ---- stdio framing helpers -------------------------------------------------

# Read a 4-byte native-endian unsigned length from stdin and print it as a
# decimal number. Prints nothing on EOF.
read_length() {
	dd bs=1 count=4 2>/dev/null | od -An -tu4 2>/dev/null | tr -dc '0-9'
}

# Read one length-prefixed message from stdin. Echoes the JSON payload and
# returns 0, or returns 1 at end of stream.
read_message() {
	len=$(read_length)
	[ -n "$len" ] || return 1
	dd bs=1 count="$len" 2>/dev/null
}

# Write one byte given its decimal value (0-255).
write_byte() {
	printf "\\$(printf '%03o' "$1")"
}

# Write a length-prefixed JSON message to stdout (native endian).
write_message() {
	msg="$1"
	len=${#msg}
	write_byte $((len & 255))
	write_byte $(((len >> 8) & 255))
	write_byte $(((len >> 16) & 255))
	write_byte $(((len >> 24) & 255))
	printf '%s' "$msg"
}

# ---- response helpers ------------------------------------------------------

send_error() {
	write_message "$(jq -nc --arg m "$1" '{status:"error", message:$m}')"
}

# $1 must be a JSON object whose keys are merged into the ok payload.
send_ok() {
	write_message "$(jq -nc --argjson d "$1" '{status:"ok"} + $d')"
}

# ---- action handlers -------------------------------------------------------

# Determine whether the configured binary is the raw pqp CLI (exposes a
# `decrypt` subcommand) or the pass-pqp wrapper (exposes `show`). The probe is
# run once per distinct binary path and cached in BIN_STYLE ("raw"|"wrapper").
BIN_STYLE=""
BIN_STYLE_FOR=""
detect_bin_style() {
	[ "$BIN_STYLE_FOR" = "$PASS_PQP_BIN" ] && return 0
	BIN_STYLE="wrapper"
	if "$PASS_PQP_BIN" decrypt --help >/dev/null 2>&1; then
		BIN_STYLE="raw"
	fi
	BIN_STYLE_FOR="$PASS_PQP_BIN"
}

cmd_list() {
	[ -d "$PREFIX" ] || {
		send_error "Password store directory not found: $PREFIX"
		return
	}
	files=$(
		find -L "$PREFIX" -path "$PREFIX/.git" -prune -o \
			-type f -name "*$ENCFILE_SUFFIX" -print 2>/dev/null |
			sed -e "s#^$PREFIX/##" -e "s#$ENCFILE_SUFFIX\$##" |
			LC_ALL=C sort
	)
	json=$(printf '%s\n' "$files" | jq -R -s 'split("\n") | map(select(length > 0))')
	send_ok "{\"files\": $json}"
}

cmd_fetch() {
	file="$1"
	case "$file" in
		''|*'..'*|/*)
			send_error "Invalid entry: ${file:-<empty>}"
			return
			;;
	esac
	tmp_out=$(mktemp) || {
		send_error "Could not create temporary file"
		return
	}
	tmp_err=$(mktemp) || {
		send_error "Could not create temporary file"
		rm -f "$tmp_out"
		return
	}
	TMP_FILES="$TMP_FILES $tmp_out $tmp_err"
	detect_bin_style
	if [ "$BIN_STYLE" = "raw" ]; then
		entry_file="$PREFIX/$file$ENCFILE_SUFFIX"
		[ -f "$entry_file" ] || {
			send_error "Could not read entry '$file': no '$file$ENCFILE_SUFFIX' in store"
			return
		}
		decrypt_opts=""
		[ "$PASS_PQP_NO_PASSPHRASE" = "1" ] && decrypt_opts="--no-passphrase"
		# shellcheck disable=SC2086
		"$PASS_PQP_BIN" decrypt $decrypt_opts -o "$tmp_out" "$entry_file" >/dev/null 2>"$tmp_err"
		rc=$?
	else
		"$PASS_PQP_BIN" show -- "$file" >"$tmp_out" 2>&1
		rc=$?
	fi
	if [ $rc -ne 0 ]; then
		err=$(cat "$tmp_err" 2>/dev/null; cat "$tmp_out" 2>/dev/null)
		send_error "Could not read entry '$file': ${err:-unknown error}"
		return
	fi
	contents=$(cat "$tmp_out")
	send_ok "{\"contents\": $(printf '%s' "$contents" | jq -Rs .)}"
}

cmd_configure() {
	store_exists=true
	[ -d "$PREFIX" ] || store_exists=false
	no_passphrase=true
	[ "$PASS_PQP_NO_PASSPHRASE" = "1" ] || no_passphrase=false
	send_ok "$(jq -nc --arg v "$HOST_VERSION" --arg d "$PREFIX" --arg b "$PASS_PQP_BIN" \
		--arg p "$PASS_PQP_PQP_BIN" --argjson s "$store_exists" --argjson n "$no_passphrase" \
		'{version:$v, storeDir:$d, passPqpBin:$b, pqpBin:$p, storeExists:$s, noPassphrase:$n}')"
}

# Apply per-message configuration overrides on top of the environment-based
# defaults. An absent config leaves the defaults untouched. Overrides never
# persist between messages: every call starts from the environment defaults.
apply_config() {
	cfg="$1"
	PASS_PQP_BIN="$DEF_PASS_PQP_BIN"
	PASS_PQP_PQP_BIN="$DEF_PASS_PQP_PQP_BIN"
	PREFIX="$DEF_PREFIX"
	export PASS_PQP_NO_PASSPHRASE="$DEF_NO_PASSPHRASE"
	export PASSWORD_STORE_DIR="$PREFIX"
	if [ -n "$PASS_PQP_PQP_BIN" ]; then
		export PASS_PQP_PQP_BIN
	else
		unset PASS_PQP_PQP_BIN
	fi
	[ -n "$cfg" ] || return 0
	bin=$(printf '%s' "$cfg" | jq -r '.passPqpBin // empty' 2>/dev/null)
	[ -n "$bin" ] && PASS_PQP_BIN="$bin"
	pqbin=$(printf '%s' "$cfg" | jq -r '.pqpBin // empty' 2>/dev/null)
	if [ -n "$pqbin" ]; then
		PASS_PQP_PQP_BIN="$pqbin"
		export PASS_PQP_PQP_BIN
	fi
	dir=$(printf '%s' "$cfg" | jq -r '.passwordStoreDir // empty' 2>/dev/null)
	if [ -n "$dir" ]; then
		PREFIX="${dir%/}"
		export PASSWORD_STORE_DIR="$PREFIX"
	fi
	if printf '%s' "$cfg" | jq -e 'has("noPassphrase")' >/dev/null 2>&1; then
		nopp=$(printf '%s' "$cfg" | jq -r '.noPassphrase' 2>/dev/null)
		case "$nopp" in
			true|True|1) export PASS_PQP_NO_PASSPHRASE=1 ;;
			false|False|0) export PASS_PQP_NO_PASSPHRASE=0 ;;
		esac
	fi
}

# ---- main loop -------------------------------------------------------------

handle() {
	msg="$1"
	action=$(printf '%s' "$msg" | jq -r '.action // empty' 2>/dev/null)
	apply_config "$(printf '%s' "$msg" | jq -c '.config // empty' 2>/dev/null)"
	case "$action" in
		list) cmd_list ;;
		fetch) cmd_fetch "$(printf '%s' "$msg" | jq -r '.file // empty' 2>/dev/null)" ;;
		configure) cmd_configure ;;
		*) send_error "Unknown action: ${action:-<empty>}" ;;
	esac
}

while msg=$(read_message); do
	handle "$msg"
done

exit 0
