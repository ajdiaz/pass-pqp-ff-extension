"use strict";

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

const ICON_AUTOFILL = [
    { tag: "path", attrs: { d: "M4 7h16" } },
    { tag: "path", attrs: { d: "M4 12h10" } },
    { tag: "path", attrs: { d: "M4 17h6" } },
    { tag: "path", attrs: { d: "M15 14l4 4" } },
    { tag: "path", attrs: { d: "M15 14h3v-3" } },
];

let toastTimer = null;
let currentHostname = null;
let allFiles = [];

init();

/**
 * Main entry point: resolve the current domain, list all entries and show the
 * domain matches, or the search results when the user has typed a query.
 *
 * @return {Promise<void>}
 */
async function init() {
    try {
        currentHostname = await getCurrentHostname();
        $("domain").textContent = currentHostname || "No domain";

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
        allFiles = (listResponse.files || []).slice().sort();

        $("search").addEventListener("input", () => {
            const query = $("search").value.trim();
            if (query) {
                renderSearchResults(query);
            } else {
                renderDomainMatches();
            }
        });

        const query = $("search").value.trim();
        if (query) {
            renderSearchResults(query);
        } else {
            renderDomainMatches();
        }
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
 * Check whether a single path segment matches the current hostname.
 *
 * A segment that contains a dot is treated as a domain pattern and is matched
 * against the hostname and its ancestors (so "facebook.com" matches
 * "www.facebook.com", and globs such as "*.example.com" work). A segment
 * without a dot (e.g. "localhost" or a username) is only considered for
 * single-label hostnames and must match the whole hostname exactly, so plain
 * directory names never act as wildcards.
 *
 * @param {string} segment  Entry path segment (may contain globs)
 * @param {string} hostname Current hostname
 * @return {boolean} True when the segment matches the hostname
 */
function matchesSegment(segment, hostname) {
    if (segment.includes(".")) {
        return matchesDomain(segment, hostname);
    }
    return !hostname.includes(".") && globToRegExp(segment).test(hostname);
}

/**
 * Check whether a store entry path matches the current hostname.
 *
 * Every path segment is inspected, so the domain may live at any depth, e.g.
 * "sites/a/facebook.com" matches "www.facebook.com" just like the flat
 * "facebook.com/user" form. A single entry matches when any of its segments
 * matches the hostname.
 *
 * @param {string} path     Store-relative entry path (e.g. "sites/facebook.com")
 * @param {string} hostname Current hostname
 * @return {boolean} True when the entry matches
 */
function matchesEntryPath(path, hostname) {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    return segments.some((segment) => matchesSegment(segment, hostname));
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
 * Render the entries that match the current domain, or an empty state.
 *
 * @return {void}
 */
function renderDomainMatches() {
    clearEntries();
    if (!currentHostname) {
        showEmpty("No domain on this page. Use the search box to find an entry.");
        return;
    }
    const matches = allFiles.filter((path) => matchesEntryPath(path, currentHostname));
    if (matches.length === 0) {
        showEmpty("No matching entries for " + currentHostname);
        return;
    }
    renderEntries(matches);
}

/**
 * Filter the full entry list with a case-insensitive substring query.
 *
 * @param {string[]} paths All entry paths
 * @param {string}   query Search query
 * @return {string[]} Matching entry paths
 */
function filterByQuery(paths, query) {
    const q = query.trim().toLowerCase();
    if (!q) {
        return [];
    }
    return paths.filter((path) => path.toLowerCase().includes(q));
}

/**
 * Render the search results for a query, or an empty state.
 *
 * @param {string} query Search query
 * @return {void}
 */
function renderSearchResults(query) {
    clearEntries();
    const matches = filterByQuery(allFiles, query);
    if (matches.length === 0) {
        showEmpty('No entries matching "' + query + '"');
        return;
    }
    renderEntries(matches);
}

/**
 * Remove all rendered entries and hide the entries list.
 *
 * @return {void}
 */
function clearEntries() {
    const list = $("entries");
    list.hidden = true;
    list.textContent = "";
    $("empty").hidden = true;
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
    actions.appendChild(buildAction("Autofill form", ICON_AUTOFILL, () => autofillField(path)));

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
 * Ask the background to fetch an entry and copy the requested field to the
 * clipboard.
 *
 * The copy itself happens in the background so it survives this popup being
 * closed while an external passphrase prompt (pinentry, ssh-askpass, ...)
 * holds focus.
 *
 * @param {string} path  Entry path
 * @param {string} field "user" or "password"
 * @return {Promise<void>}
 */
async function copyField(path, field) {
    const response = await browser.runtime.sendMessage({
        action: "copyEntry",
        file: path,
        field,
    });
    if (response.status !== "ok") {
        showToast("Error: " + response.message);
        return;
    }
    showToast("Copied " + field);
}

/**
 * Ask the background to fetch an entry and fill the page's login form with its
 * password and username.
 *
 * Like {@link copyField} this runs in the background so a focus-stealing
 * passphrase prompt cannot cancel it by closing the popup.
 *
 * @param {string} path Entry path
 * @return {Promise<void>}
 */
async function autofillField(path) {
    const response = await browser.runtime.sendMessage({
        action: "autofillEntry",
        file: path,
    });
    if (response.status !== "ok") {
        showToast("Error: " + response.message);
        return;
    }
    showToast("Autofilled " + path);
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
