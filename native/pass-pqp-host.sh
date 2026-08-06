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
# The store paths returned by "list" are relative to the password store root
# and have the `.pqp.enc` suffix stripped, e.g. "github.com/username".
#
# Configuration via environment variables:
#   PASS_PQP_BIN            path to the pass-pqp binary (default: pass-pqp)
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
PREFIX="${PASSWORD_STORE_DIR:-$HOME/.password-store}"
PREFIX="${PREFIX%/}"
ENCFILE_SUFFIX=".pqp.enc"
export PASS_PQP_NO_PASSPHRASE="${PASS_PQP_NO_PASSPHRASE:-1}"

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
	TMP_FILES="$TMP_FILES $tmp_out"
	"$PASS_PQP_BIN" show -- "$file" >"$tmp_out" 2>&1
	rc=$?
	if [ $rc -ne 0 ]; then
		err=$(cat "$tmp_out")
		send_error "Could not read entry '$file': ${err:-unknown error}"
		return
	fi
	contents=$(cat "$tmp_out")
	send_ok "{\"contents\": $(printf '%s' "$contents" | jq -Rs .)}"
}

cmd_configure() {
	send_ok "$(jq -nc --arg v "$HOST_VERSION" --arg d "$PREFIX" --arg b "$PASS_PQP_BIN" \
		'{version:$v, storeDir:$d, passPqpBin:$b}')"
}

# ---- main loop -------------------------------------------------------------

handle() {
	msg="$1"
	action=$(printf '%s' "$msg" | jq -r '.action // empty' 2>/dev/null)
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
