# 🔐 pass-pqp Firefox / LibreWolf extension

A minimal browser extension that brings the [`pass-pqp`](https://github.com/ajdiaz/pass-pqp)
password store to Firefox and LibreWolf.

Click the toolbar icon and the popup shows every store entry whose domain
matches the **current page's domain** (glob-aware). Each entry gets two
buttons: one to copy the **username** and one to copy the **password**. If no
entry matches the domain, or you are looking for something specific, type in
the **search box** to filter the whole store by name.

---

## ✨ Features

- 🔎 **Domain matching with globs** — entries like `github.com/username` match
  the current host; `*.example.com/service` matches any subdomain of
  `example.com`, and nested stores such as `sites/a/facebook.com` match
  `www.facebook.com` too.
- 🔍 **Search the whole store** — when no entry matches the current domain (or
  any time), type in the popup's search box to filter every entry by name
  (case-insensitive substring).
- 📋 **One-click copy** — copy the username or the password straight to the
  clipboard.
- 🪟 **Prompt-safe actions** — copying and autofilling run in the background
  script, so they still complete when an external passphrase prompt
  (`pinentry`, `ssh-askpass`, …) steals focus and the popup closes.
- 🔐 **Native messaging** — a thin native host bridges the extension to the
  real `pass-pqp` binary; the store is never touched by the browser directly.
- 🦊 **Firefox + LibreWolf** — targets the latest Firefox and stays compatible
  with LibreWolf.

---

## 🧱 Architecture

```
┌──────────────┐   native messaging    ┌───────────────────────────┐
│  popup       │ ────────────────────► │ background script         │
│  (UI, glob   │                       │ (src/background.js)       │
│   matching)  │ ◄──────────────────── │                           │
└──────────────┘                       └───────────┬───────────────┘
                                                   │ browser.runtime.sendNativeMessage
                                                   ▼
                                    ┌──────────────────────────────┐
                                    │  native host                 │
                                    │  (native/pass-pqp-host.sh)   │
                                    └───────────┬──────────────────┘
                                                │ runs CLI commands
                                                ▼
                                    ┌──────────────────────────────┐
                                    │  pass-pqp  ◄──►  pqp         │
                                    │  ~/.password-store (git)     │
                                    └──────────────────────────────┘
```

WebExtensions cannot run shell commands, so the extension talks to a **native
messaging host**. The host speaks the native messaging protocol
(length-prefixed JSON over stdio) and translates three actions into `pass-pqp`
invocations:

| Action | CLI call | Returns |
|---|---|---|
| `configure` | — | host version, store directory, `pass-pqp` / `pqp` / password tool |
| `list` | `find` over `*.pqp.enc` | every store-relative entry path |
| `fetch` | `pass-pqp show <entry>`, or `pqp decrypt` when configured with the raw `pqp` CLI (each with `--no-passphrase` or `--password-tool`) | the decrypted entry contents |

The domain matching itself happens in the extension (popup), following the
browserpass approach. The popup only renders the UI: fetching an entry,
copying a field to the clipboard, and autofilling a form all run in the
**background script**, so they survive the popup being closed while an
external passphrase prompt holds focus.

---

## 📦 Requirements

- **Browser**: Firefox ≥ 115 or LibreWolf.
- **Store**: a `pass-pqp` password store (`pass-pqp init …`, see the
  [pass-pqp README](https://github.com/ajdiaz/pass-pqp)).
- **Host tools**: POSIX `sh`, [`jq`](https://jqlang.github.io/jq/), `dd`,
  `od`, `find`, `sed` — all standard on Linux.
- **Keys**: the recipient key must be usable **without a passphrase**
  (`pqp gen-key --no-passphrase …`). The host sets
  `PASS_PQP_NO_PASSPHRASE=1` so decryption never blocks on a terminal prompt
  (see [Security](#-security-notes)).

---

## 🚀 Installation

### 1. Install the native host

The native host must be installed and registered with your browser:

```console
$ make install                          # installs to /usr/local (may need sudo)
$ make install PREFIX=$HOME/.local      # or install into your home directory
```

This copies `native/pass-pqp-host.sh` to `$(PREFIX)/lib/pass-pqp-ff-extension/`
and writes the native messaging manifest to:

- `~/.mozilla/native-messaging-hosts/pass_pqp_host.json` (Firefox)
- `~/.librewolf/native-messaging-hosts/pass_pqp_host.json` (LibreWolf)

### 2. Load the extension

```console
$ make build            # creates dist/pass-pqp-ff-extension-0.1.0.zip
```

Then in Firefox / LibreWolf:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select the zip (or any file inside it).

> 🔑 Make sure `pass-pqp` is in your `PATH` (or set `PASS_PQP_BIN`), and the
> `PASSWORD_STORE_DIR` (default `~/.password-store`) points at your store.

### 3. Use it

1. Visit a site, e.g. `https://github.com/`.
2. Click the pass-pqp toolbar icon.
3. Every entry matching `github.com` appears in the dropdown.
4. Click 👤 to copy the username, 🔑 to copy the password, or the **autofill**
   button to fill the page's login form directly.
5. No matching entry? Type in the search box to filter the whole store by
   entry name (e.g. `alice` finds `github.com/alice` even on `gitlab.com`).

### Autofill

The autofill button finds the login form on the current page and fills it:

- **Password field** — the first `input[type="password"]`, or any input whose
  tag or attributes (id, name, class, placeholder, …) contain the word
  `password`.
- **Username field** — an `input[type="email"]` or `input[type="text"]` whose
  tag or attributes contain the word `user` or `login`.

The password is the first line of the decrypted entry; the username comes from
the first `user:` or `login:` line (e.g. `login: alice` or `user:alice`).
Other lines are ignored. Values are written with native setters and `input` +
`change` events are dispatched so framework bindings (React, Vue, …) pick them
up.

### Passphrase prompts

Decryption is performed by the native host, triggered from the extension's
**background script** — not from the popup. This matters when the store key is
passphrase-protected and `passwordTool` is configured: the tool's prompt (a
pinentry dialog, a terminal prompt, …) takes keyboard focus, which makes the
browser close the popup. Because the background script owns the work, the
credential is still copied or the form is still filled once the passphrase is
accepted; you don't need to reopen the popup.

If your password tool needs arguments (for example
`pinentry-curses --ttyname=/dev/pts/0`), point `passPqpBin` at the raw `pqp`
CLI rather than the `pass-pqp` wrapper: the wrapper forwards the tool through
the environment and splits it on whitespace. The native host passes the whole
tool command to `pqp` as a single `--password-tool` value.

---

## 🎯 How matching works

Entries are stored in `pass` convention; a segment of the entry path that looks
like a domain (contains a dot) is matched against the current hostname. The
domain segment does **not** have to be the first one, so entries organized in
subdirectories are found as well:

- `github.com/username` → matches host `github.com`.
- `login.github.com/admin` → matches host `login.github.com`.
- `example.com/team` → also matches host `www.example.com` (subdomain rule).
- `*.example.com/service` → matches any subdomain of `example.com` (glob `*`
  and `?` are supported).
- `sites/a/facebook.com` → matches host `www.facebook.com` (the domain can be
  any path segment).

The extension also matches entries when the current host is a **subdomain** of
the entry's domain segment, so a single `example.com/…` entry covers
`www.example.com`. Segments without a dot (e.g. a `localhost` entry) only match
a single-label hostname exactly and never act as a wildcard, so plain
directory names such as `personal/notes` do not match unrelated sites.

## 🗂️ Entry format

Entries are plain `pass`-style text:

```
hunter2
login: alice
url: https://github.com
```

- The **password** is the first non-empty line — or the value of a
  `password:` / `pass:` / `secret:` line when present.
- The **username** is the value of a `login:` / `username:` / `user:` line, or
  falls back to the last path segment of the entry name.

---

## ⚙️ Configuration

### Options page

Open the extension's preferences via the add-on manager
(`about:addons` → pass-pqp → ⚙) or right-click the toolbar icon →
**Manage Extension**. The options page lets you set:

| Setting | Default | Purpose |
|---|---|---|
| `passPqpBin` | *empty* | Path to the `pass-pqp` wrapper **or** the raw `pqp` CLI. Empty falls back to `PASS_PQP_BIN` / `pass-pqp`. The host probes the binary: `show` for the wrapper, `decrypt` for the raw CLI. |
| `pqpBin` | *empty* | Path to the raw `pqp` CLI. Only needed when `passPqpBin` points at the `pass-pqp` wrapper, so the wrapper can find `pqp` (the browser environment usually does not have it on PATH). Empty falls back to `PASS_PQP_PQP_BIN` / `pqp`. |
| `passwordStoreDir` | *empty* | Location of the password store. Empty falls back to `PASSWORD_STORE_DIR` / `~/.password-store`. |
| `noPassphrase` | on | Decrypt without a passphrase prompt (`PASS_PQP_NO_PASSPHRASE=1`). One of `noPassphrase` or `passwordTool` is mandatory. |
| `passwordTool` | *none* | External passphrase prompt tool passed as `--password-tool` (e.g. `pinentry`, `ssh-askpass`). Used only when `noPassphrase` is off; one of the two is mandatory. |

The page also probes the host and shows the **effective** store directory,
binaries, password tool, and store status — so you can verify your settings
immediately.

Settings are stored with `browser.storage.local` and are merged into **every**
native host request as a `config` object (see below). The browser never sends
these settings anywhere except to your own native host.

### Native host environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PASS_PQP_BIN` | `pass-pqp` | Path to the `pass-pqp` wrapper or the raw `pqp` CLI. |
| `PASS_PQP_PQP_BIN` | *unset* | Path to the raw `pqp` CLI, exported to `pass-pqp` wrapper subprocesses. |
| `PASS_PQP_PASSWORD_TOOL` | *unset* | External passphrase prompt tool, forwarded to decryption as `--password-tool`. |
| `PASSWORD_STORE_DIR` | `~/.password-store` | Location of the password store. |
| `PASS_PQP_NO_PASSPHRASE` | `1` | Decrypt without a passphrase prompt. Set to `0` only if you handle prompts yourself (not recommended in the browser). |

### Native host protocol

Requests and responses are JSON messages. Every request may carry an optional
`config` object that overrides the environment-based defaults **for that single
message only** — overrides never leak into later messages:

```jsonc
// request with config override
{"action": "list", "config": {
    "passPqpBin": "/home/alice/bin/pass-pqp",
    "pqpBin": "/home/alice/bin/pqp",
    "passwordTool": "pinentry",
    "passwordStoreDir": "/home/alice/passwords",
    "noPassphrase": false
}}
// response
{"status": "ok", "files": ["github.com/alice", "*.example.com/service"]}

// request
{"action": "fetch", "file": "github.com/alice"}
// response
{"status": "ok", "contents": "hunter2\nlogin: alice\n"}

// request
{"action": "configure"}
// response
{"status": "ok", "version": "0.1.0", "storeDir": "/home/alice/.password-store", "passPqpBin": "pass-pqp", "pqpBin": "/home/alice/bin/pqp", "passwordTool": "pinentry", "storeExists": true, "noPassphrase": false}
```

The `configure` response reflects the *effective* configuration for that
message, i.e. after applying any `config` override. The extension's options
page uses this to display the active settings.

Errors always return `{"status": "error", "message": "…"}`. The host rejects
entry names that are empty, absolute, or contain `..`.

---

## 🔒 Security notes

- **The store lives on your machine** and is accessed through `pass-pqp`; the
  browser only ever sees the decrypted contents of the single entry you ask
  for.
- **Passphrase handling.** Decryption needs exactly one of two modes: either
  passphrase-less keys (`noPassphrase` on, keys created with
  `pqp gen-key --no-passphrase`), or an external password tool
  (`passwordTool`, e.g. `pinentry` or `ssh-askpass`) that answers the
  passphrase prompt. A browser popup cannot answer a terminal prompt itself,
  so one of the two is mandatory.
- **Minimal host permissions.** The extension needs `tabs`/`activeTab` to read
  the current URL, `nativeMessaging` to reach the host, `clipboardWrite` to
  copy, and `storage` for the options. The autofill content script runs on
  every page (`<all_urls>`) but only acts on explicit autofill messages sent
  by the popup — it reads or modifies page content only when you click the
  autofill button.
- The extension does not transmit anything over the network.

---

## 🧑‍💻 Development

```console
$ make build      # package the extension into dist/*.zip
$ make install    # install the native host and manifests
$ make uninstall  # remove every created file (host, manifests, dist/, web-ext-artifacts/)
$ make clean      # remove build artifacts only (dist/, web-ext-artifacts/)
```

The native host can be exercised directly with any JSON framing tool; a quick
manual check:

```console
$ printf '\x1c\x00\x00\x00{"action":"configure"}' | native/pass-pqp-host.sh
```

---

## 🔗 Links

- 🏠 Project: <https://github.com/ajdiaz/pass-pqp-ff-extension>
- 🗂️ Password store: <https://github.com/ajdiaz/pass-pqp>
- 🧮 Backend: <https://github.com/ajdiaz/pqp>

---

## 📜 License

MIT.
