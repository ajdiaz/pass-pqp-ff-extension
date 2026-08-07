# 🔐 pass-pqp Firefox / LibreWolf extension

A minimal browser extension that brings the [`pass-pqp`](https://github.com/pass-pqp/pass-pqp)
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
  `example.com`.
- 🔍 **Search the whole store** — when no entry matches the current domain (or
  any time), type in the popup's search box to filter every entry by name
  (case-insensitive substring).
- 📋 **One-click copy** — copy the username or the password straight to the
  clipboard.
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
| `configure` | — | host version, store directory, `pass-pqp` binary path |
| `list` | `find` over `*.pqp.enc` | every store-relative entry path |
| `fetch` | `pass-pqp show <entry>` | the decrypted entry contents |

The domain matching itself happens in the extension (popup), following the
browserpass approach.

---

## 📦 Requirements

- **Browser**: Firefox ≥ 115 or LibreWolf.
- **Store**: a `pass-pqp` password store (`pass-pqp init …`, see the
  [pass-pqp README](https://github.com/pass-pqp/pass-pqp)).
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
4. Click 👤 to copy the username or 🔑 to copy the password.
5. No matching entry? Type in the search box to filter the whole store by
   entry name (e.g. `alice` finds `github.com/alice` even on `gitlab.com`).

---

## 🎯 How matching works

Entries are stored in `pass` convention: the first path segment is the domain
and is matched against the current hostname:

- `github.com/username` → matches host `github.com`.
- `login.github.com/admin` → matches host `login.github.com`.
- `example.com/team` → also matches host `www.example.com` (subdomain rule).
- `*.example.com/service` → matches any subdomain of `example.com` (glob `*`
  and `?` are supported).

The extension also matches entries when the current host is a **subdomain** of
the entry's domain segment, so a single `example.com/…` entry covers
`www.example.com`.

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
| `passPqpBin` | *empty* | Path to the `pass-pqp` binary. Empty falls back to `PASS_PQP_BIN` / `pass-pqp`. |
| `passwordStoreDir` | *empty* | Location of the password store. Empty falls back to `PASSWORD_STORE_DIR` / `~/.password-store`. |
| `noPassphrase` | on | Decrypt without a passphrase prompt (`PASS_PQP_NO_PASSPHRASE=1`). |

The page also probes the host and shows the **effective** store directory,
binary, and store status — so you can verify your settings immediately.

Settings are stored with `browser.storage.local` and are merged into **every**
native host request as a `config` object (see below). The browser never sends
these settings anywhere except to your own native host.

### Native host environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PASS_PQP_BIN` | `pass-pqp` | Path to the `pass-pqp` binary. |
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
    "passwordStoreDir": "/home/alice/passwords",
    "noPassphrase": true
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
{"status": "ok", "version": "0.1.0", "storeDir": "/home/alice/.password-store", "passPqpBin": "pass-pqp", "storeExists": true, "noPassphrase": true}
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
- **Passphrase-less keys required.** The host runs decryption with
  `PASS_PQP_NO_PASSPHRASE=1` because a browser popup cannot answer a terminal
  passphrase prompt. Create keys with `pqp gen-key --no-passphrase`.
- **No host permissions are requested** — the extension never reads page
  content, and only needs `tabs`/`activeTab` to read the current URL,
  `nativeMessaging` to reach the host, `clipboardWrite` to copy, and `storage`
  to keep your options page settings.
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

## 📜 License

MIT.
