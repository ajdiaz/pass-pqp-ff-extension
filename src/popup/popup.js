"use strict";

const PASSWORD_KEYS = ["password", "pass", "secret"];
const USERNAME_KEYS = ["login", "username", "user"];

const $ = (id) => document.getElementById(id);

const ICON_USER = [
    { tag: "path", attrs: { d: "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" } },
    { tag: "path", attrs: { d: "M4 21a8 8 0 0 1 16 0" } },
];

const ICON_KEY = [
    { tag: "circle", attrs: { cx: "8", cy: "15", r: "4" } },
    { tag: "path", attrs: { d: "M11 12l9-9" } },
    { tag: "path", attrs: { d: "M17 6l3 3" } },
    { tag: "path", attrs: { d: "M14 9l2 2" } },
];

let toastTimer = null;

init();

/**
 * Main entry point: resolve the current domain, list matching entries and
 * render them.
 *
 * @return {Promise<void>}
 */
async function init() {
    try {
        const hostname = await getCurrentHostname();
        $("domain").textContent = hostname || "No domain";
        if (!hostname) {
            showNotice("This page does not have a domain.");
            return;
        }

        const hostCheck = await browser.runtime.sendMessage({ action: "checkHost" });
        if (hostCheck.status !== "ok") {
            showNotice(hostCheck.message);
            return;
        }
        $("store").textContent = hostCheck.storeDir || "";

        const listResponse = await browser.runtime.sendMessage({ action: "listEntries" });
        if (listResponse.status !== "ok") {
            showNotice(listResponse.message);
            return;
        }

        const matches = listResponse.files
            .filter((path) => matchesEntryPath(path, hostname))
            .sort();

        if (matches.length === 0) {
            showEmpty("No matching entries for " + hostname);
            return;
        }
        renderEntries(matches);
    } catch (e) {
        showNotice(e.message);
    }
}

/**
 * Resolve the hostname of the active tab, or null when unavailable.
 *
 * @return {Promise<string|null>} Lower-cased hostname
 */
async function getCurrentHostname() {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.url) {
        return null;
    }
    try {
        const url = new URL(tab.url);
        return url.hostname ? url.hostname.toLowerCase() : null;
    } catch (e) {
        return null;
    }
}

/**
 * Convert a glob pattern (`*` and `?`) into a case-insensitive RegExp.
 *
 * @param {string} pattern Glob pattern
 * @return {RegExp} Compiled regex
 */
function globToRegExp(pattern) {
    const out = [];
    for (const ch of pattern) {
        if (ch === "*") {
            out.push(".*");
        } else if (ch === "?") {
            out.push(".");
        } else if ("\\^$+()[]{}|.".includes(ch)) {
            out.push("\\" + ch);
        } else {
            out.push(ch);
        }
    }
    return new RegExp("^" + out.join("") + "$", "i");
}

/**
 * Check whether a domain pattern matches a hostname, considering that the
 * hostname may be a subdomain of the pattern (e.g. "example.com" matches
 * "www.example.com").
 *
 * @param {string} pattern  Domain pattern (may contain globs)
 * @param {string} hostname Current hostname
 * @return {boolean} True when the pattern matches the hostname or an ancestor
 */
function matchesDomain(pattern, hostname) {
    const regex = globToRegExp(pattern);
    let h = hostname;
    for (;;) {
        if (regex.test(h)) {
            return true;
        }
        const dot = h.indexOf(".");
        if (dot === -1) {
            return false;
        }
        h = h.slice(dot + 1);
    }
}

/**
 * Check whether a store entry path matches the current hostname. The first
 * path segment is treated as the domain pattern.
 *
 * @param {string} path     Store-relative entry path (e.g. "github.com/user")
 * @param {string} hostname Current hostname
 * @return {boolean} True when the entry matches
 */
function matchesEntryPath(path, hostname) {
    const segment = path.split("/")[0];
    return segment.length > 0 && matchesDomain(segment, hostname);
}

/**
 * Render the list of matching entry paths.
 *
 * @param {string[]} paths Entry paths
 * @return {void}
 */
function renderEntries(paths) {
    const list = $("entries");
    list.hidden = false;
    for (const path of paths) {
        list.appendChild(buildEntry(path));
    }
}

/**
 * Build a single list item with copy-user and copy-password buttons.
 *
 * @param {string} path Entry path
 * @return {HTMLElement} List item element
 */
function buildEntry(path) {
    const item = document.createElement("li");
    item.className = "entry";

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.appendChild(buildAction("Copy username", ICON_USER, () => copyField(path, "user")));
    actions.appendChild(
        buildAction("Copy password", ICON_KEY, () => copyField(path, "password"))
    );

    const name = document.createElement("div");
    name.className = "name";
    name.textContent = path;
    name.title = path;

    item.appendChild(actions);
    item.appendChild(name);
    return item;
}

/**
 * Build a stroke-based SVG element from a list of element descriptors.
 *
 * @param {Array<{tag: string, attrs: object}>} elements Element descriptors
 * @return {SVGElement} SVG element
 */
function buildSvgIcon(elements) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    for (const el of elements) {
        const node = document.createElementNS("http://www.w3.org/2000/svg", el.tag);
        for (const attr in el.attrs) {
            node.setAttribute(attr, el.attrs[attr]);
        }
        svg.appendChild(node);
    }
    return svg;
}

/**
 * Build an action button.
 *
 * @param {string}   title          Tooltip text
 * @param {Array}    iconElements   SVG element descriptors
 * @param {Function} onClick        Click handler
 * @return {HTMLButtonElement} Button element
 */
function buildAction(title, iconElements, onClick) {
    const button = document.createElement("button");
    button.className = "action";
    button.type = "button";
    button.title = title;
    button.appendChild(buildSvgIcon(iconElements));
    button.addEventListener("click", onClick);
    return button;
}

/**
 * Fetch an entry and copy the requested field to the clipboard.
 *
 * @param {string} path  Entry path
 * @param {string} field "user" or "password"
 * @return {Promise<void>}
 */
async function copyField(path, field) {
    const response = await browser.runtime.sendMessage({ action: "fetchEntry", file: path });
    if (response.status !== "ok") {
        showToast("Error: " + response.message);
        return;
    }
    const entry = parseEntry(response.contents);
    const value = field === "password" ? entry.password : entry.user || deriveUser(path);
    if (!value) {
        showToast("No " + field + " found for " + path);
        return;
    }
    await copyText(value);
    showToast("Copied " + field);
}

/**
 * Parse pass-compatible entry contents into password and user fields.
 *
 * The first non-empty line is the password; lines like "login: user" provide
 * the username. A keyed "password:"/"pass:"/"secret:" line overrides the
 * first line.
 *
 * @param {string} raw Decrypted entry contents
 * @return {{password: string, user: string}} Parsed fields
 */
function parseEntry(raw) {
    const lines = raw
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const entry = { password: "", user: "" };
    for (const line of lines) {
        const match = line.match(/^([^:]+):\s*(.*)$/);
        if (!match) {
            continue;
        }
        const key = match[1].toLowerCase();
        const value = match[2];
        if (!entry.user && USERNAME_KEYS.includes(key)) {
            entry.user = value;
        }
        if (!entry.password && PASSWORD_KEYS.includes(key)) {
            entry.password = value;
        }
    }
    if (!entry.password && lines.length > 0) {
        entry.password = lines[0];
    }
    return entry;
}

/**
 * Derive a username from the last segment of an entry path.
 *
 * @param {string} path Entry path
 * @return {string} Derived username
 */
function deriveUser(path) {
    return path.split("/").pop();
}

/**
 * Copy text to the clipboard, preferring the async clipboard API and falling
 * back to a hidden textarea with execCommand.
 *
 * @param {string} text Text to copy
 * @return {Promise<void>}
 */
async function copyText(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }
    } catch (e) {
        // fall through to the execCommand fallback
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
}

/**
 * Show a persistent error/notice message.
 *
 * @param {string} message Message text
 * @return {void}
 */
function showNotice(message) {
    const notice = $("notice");
    notice.textContent = message;
    notice.hidden = false;
}

/**
 * Show the empty-state message.
 *
 * @param {string} message Message text
 * @return {void}
 */
function showEmpty(message) {
    const empty = $("empty");
    empty.textContent = message;
    empty.hidden = false;
}

/**
 * Show a transient toast message.
 *
 * @param {string} message Message text
 * @return {void}
 */
function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.hidden = false;
    if (toastTimer) {
        clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(() => {
        toast.hidden = true;
    }, 1600);
}
