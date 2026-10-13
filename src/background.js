"use strict";

// Background page of the pass-pqp extension.
//
// It owns every long-running operation (listing the store, decrypting an
// entry, copying a field to the clipboard and filling a page's login form) so
// they survive the popup being dismissed. The popup is closed by the browser
// as soon as an external passphrase prompt (pinentry, ssh-askpass, ...)
// steals focus, long before the native host replies, so a copy started in the
// popup would otherwise be cancelled.
//
// Results produced while the popup was closed are stored in
// `browser.storage.session` and shown the next time the popup opens; failures
// are additionally announced with a desktop notification and the toolbar
// badge, so a wrong passphrase never fails silently.
//
// The browser does not let a background page call the passphrase prompt
// itself: all store access is delegated to the `pass_pqp_host` native
// messaging host (see native/pass-pqp-host.sh).

// Native messaging host name; must match the "name" field of the installed
// native messaging manifest (see native/pass-pqp-host.json.in).
const HOST_NAME = "pass_pqp_host";

// Entry keys recognised when parsing pass-compatible contents.
const PASSWORD_KEYS = ["password", "pass", "secret"];
const USERNAME_KEYS = ["login", "username", "user"];

// Default extension settings. Empty strings mean "use the native host
// default" (environment variable or built-in default).
const DEFAULT_SETTINGS = {
    passPqpBin: "",
    pqpBin: "",
    passwordTool: "",
    passwordStoreDir: "",
    noPassphrase: true,
};

// Name of the runtime port every open popup connects to. The background uses
// it to tell whether the outcome of a copy/autofill can still be shown in the
// popup or has to be announced with a desktop notification instead.
const POPUP_PORT = "popup";

// Notification id reused for every failure so a new error replaces the
// previous message instead of stacking up.
const NOTIFICATION_ID = "pass-pqp-result";

// Popup documents currently connected to this background page.
const popupPorts = new Set();

browser.runtime.onConnect.addListener((port) => {
    if (port.name !== POPUP_PORT) {
        return;
    }
    popupPorts.add(port);
    port.onDisconnect.addListener(() => {
        popupPorts.delete(port);
    });
});

// Route messages coming from the popup or options page to the native
// messaging host.
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sendResponse);
    // keep the response channel open for the async work above
    return true;
});

/**
 * Handle a single message from the popup or options page.
 *
 * @param {object}   message      Message
 * @param {function} sendResponse Callback to send the response
 * @return {void}
 */
async function handleMessage(message, sendResponse) {
    try {
        if (!message || typeof message.action !== "string") {
            throw new Error("Message is missing an action");
        }
        let response;
        switch (message.action) {
            case "checkHost":
                response = await sendHostRequest({ action: "configure" });
                break;
            case "listEntries":
                response = await sendHostRequest({ action: "list" });
                break;
            case "fetchEntry":
                if (typeof message.file !== "string" || message.file.length === 0) {
                    throw new Error("fetchEntry requires a non-empty file");
                }
                response = await sendHostRequest({ action: "fetch", file: message.file });
                break;
            case "autofill":
                if (typeof message.password !== "string") {
                    throw new Error("autofill requires a password");
                }
                response = await autofillPage(message.password, message.user);
                break;
            case "copyEntry":
                response = await copyEntry(message.file, message.field);
                await recordResult("copy", message.file, response, message.field);
                break;
            case "autofillEntry":
                response = await autofillEntry(message.file);
                await recordResult("autofill", message.file, response);
                break;
            case "getLastResult":
                response = await takeLastResult();
                break;
            case "clearLastResult":
                await clearResult();
                response = { status: "ok" };
                break;
            case "getConfig":
                response = await getConfig();
                break;
            case "saveConfig":
                if (!message.settings || typeof message.settings !== "object") {
                    throw new Error("saveConfig requires a settings object");
                }
                response = await saveConfig(message.settings);
                break;
            default:
                throw new Error("Unknown action: " + message.action);
        }
        safeRespond(sendResponse, response);
    } catch (e) {
        safeRespond(sendResponse, { status: "error", message: e.message });
    }
}

/**
 * Send a response without letting a closed message channel (typically the
 * popup being dismissed while a focus-stealing passphrase prompt is shown)
 * surface as an error. The operation itself has already completed.
 *
 * @param {function} sendResponse Response callback
 * @param {object}   response     Payload to send
 * @return {void}
 */
function safeRespond(sendResponse, response) {
    if (typeof sendResponse !== "function") {
        return;
    }
    try {
        sendResponse(response);
    } catch (e) {
        // The receiver is gone; nothing to do.
    }
}

/**
 * @return {boolean} True while at least one popup document is connected.
 */
function popupIsOpen() {
    return popupPorts.size > 0;
}

/**
 * Persist the outcome of a background copy/autofill so the popup can present
 * it the next time it opens. When the popup is already gone (the common case
 * with a focus-stealing passphrase prompt) a failure is surfaced immediately
 * through a desktop notification and the toolbar badge.
 *
 * @param {string} kind      "copy" or "autofill"
 * @param {string} file      Entry path the operation worked on
 * @param {object} response  Status object returned by the operation
 * @param {string} [field]   Field that was copied ("user"/"password")
 * @return {Promise<void>}
 */
async function recordResult(kind, file, response, field) {
    const result = {
        id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        kind,
        file,
        field: field || "",
        status: response.status,
        message: response.message || "",
        timestamp: Date.now(),
    };
    try {
        await browser.storage.session.set({ lastResult: result });
    } catch (e) {
        // storage.session is best-effort: never fail the operation over it.
    }
    if (response.status !== "ok" && !popupIsOpen()) {
        await notifyResult(result);
    }
}

/**
 * Surface a failed background operation through a desktop notification and
 * the toolbar badge, so a wrong passphrase or a missing key is still reported
 * after the popup has been dismissed.
 *
 * @param {object} result Recorded result object
 * @return {Promise<void>}
 */
async function notifyResult(result) {
    try {
        await browser.action.setBadgeBackgroundColor({ color: "#cc0000" });
        await browser.action.setBadgeText({ text: "!" });
    } catch (e) {
        // Badges are cosmetic; keep going.
    }
    try {
        await browser.notifications.create(NOTIFICATION_ID, {
            type: "basic",
            iconUrl: browser.runtime.getURL("icons/icon.svg"),
            title: "pass-pqp",
            message: result.message || "The operation failed",
        });
    } catch (e) {
        // Notifications may be unavailable; the badge and the toast shown the
        // next time the popup opens still carry the message.
    }
}

/**
 * Return the recorded result (if any) and clear it together with the error
 * badge. The popup calls this every time it opens, so a result produced while
 * the popup was closed is shown exactly once.
 *
 * @return {Promise<{status: string, result: object|null}>}
 */
async function takeLastResult() {
    let result = null;
    try {
        const stored = await browser.storage.session.get({ lastResult: null });
        result = stored.lastResult || null;
    } catch (e) {
        result = null;
    }
    await clearResult();
    return { status: "ok", result };
}

/**
 * Drop any recorded result and clear the toolbar badge.
 *
 * @return {Promise<void>}
 */
async function clearResult() {
    try {
        await browser.storage.session.remove("lastResult");
    } catch (e) {
        // Ignore: nothing to clear.
    }
    try {
        await browser.action.setBadgeText({ text: "" });
    } catch (e) {
        // Ignore: no badge support.
    }
}

/**
 * Load and normalize the extension settings from local storage.
 *
 * @return {Promise<{passPqpBin: string, pqpBin: string, passwordTool: string, passwordStoreDir: string, noPassphrase: boolean}>}
 */
async function getSettings() {
    const stored = await browser.storage.local.get(DEFAULT_SETTINGS);
    return sanitizeSettings(stored);
}

/**
 * Normalize a raw settings object into the canonical shape.
 *
 * @param {object} raw Raw settings object
 * @return {{passPqpBin: string, pqpBin: string, passwordTool: string, passwordStoreDir: string, noPassphrase: boolean}}
 */
function sanitizeSettings(raw) {
    return {
        passPqpBin: typeof raw.passPqpBin === "string" ? raw.passPqpBin.trim() : "",
        pqpBin: typeof raw.pqpBin === "string" ? raw.pqpBin.trim() : "",
        passwordTool: typeof raw.passwordTool === "string" ? raw.passwordTool.trim() : "",
        passwordStoreDir:
            typeof raw.passwordStoreDir === "string" ? raw.passwordStoreDir.trim() : "",
        noPassphrase: raw.noPassphrase !== false,
    };
}

/**
 * Build the config override object sent to the native host, omitting empty
 * settings so the host keeps its defaults.
 *
 * @param {object} settings Normalized settings
 * @return {object} Config override object
 */
function buildConfig(settings) {
    const config = {};
    if (settings.passPqpBin) {
        config.passPqpBin = settings.passPqpBin;
    }
    if (settings.pqpBin) {
        config.pqpBin = settings.pqpBin;
    }
    if (settings.passwordTool) {
        config.passwordTool = settings.passwordTool;
    }
    if (settings.passwordStoreDir) {
        config.passwordStoreDir = settings.passwordStoreDir;
    }
    if (typeof settings.noPassphrase === "boolean") {
        config.noPassphrase = settings.noPassphrase;
    }
    return config;
}

/**
 * Send a request to the native messaging host, merged with the stored
 * settings, and normalize the response.
 *
 * @param {object} request Request object for the native host
 * @return {object} Response from the host
 */
async function sendHostRequest(request) {
    const settings = await getSettings();
    const fullRequest = Object.assign({}, request, { config: buildConfig(settings) });
    try {
        const response = await browser.runtime.sendNativeMessage(HOST_NAME, fullRequest);
        if (response && typeof response === "object") {
            return response;
        }
        return { status: "error", message: "Native host returned an empty response" };
    } catch (e) {
        return {
            status: "error",
            message:
                "Unable to reach the pass-pqp native host. " +
                "Is the host installed and registered for this extension? Details: " + e.message,
        };
    }
}

/**
 * Return the stored settings plus a host probe so the options page can show
 * the effective configuration.
 *
 * @return {Promise<{status: string, settings: object, host: object}>}
 */
async function getConfig() {
    const settings = await getSettings();
    const host = await sendHostRequest({ action: "configure" });
    return { status: "ok", settings, host };
}

/**
 * Persist settings and probe the host with them.
 *
 * @param {object} rawSettings Raw settings from the options page
 * @return {Promise<{status: string, settings: object, host: object}>}
 */
async function saveConfig(rawSettings) {
    const settings = sanitizeSettings(rawSettings);
    await browser.storage.local.set(settings);
    const host = await sendHostRequest({ action: "configure" });
    return { status: "ok", settings, host };
}

/**
 * Ask the content script of the active tab to autofill a login form.
 *
 * @param {string} password Password value
 * @param {string} user     Username value, may be empty
 * @return {Promise<object>} Content script response or an error
 */
async function autofillPage(password, user) {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || typeof tab.id !== "number") {
        return { status: "error", message: "No active tab available" };
    }
    try {
        const response = await browser.tabs.sendMessage(tab.id, {
            action: "autofill",
            password,
            user: typeof user === "string" ? user : "",
        });
        if (response && typeof response === "object") {
            return response;
        }
        return { status: "error", message: "Autofill script returned an empty response" };
    } catch (e) {
        return {
            status: "error",
            message:
                "Unable to autofill this page. The autofill script may not be loaded. Details: " +
                e.message,
        };
    }
}

/**
 * Fetch an entry from the native host and copy one of its fields to the
 * clipboard.
 *
 * This runs in the background on purpose: when decryption uses an external
 * passphrase tool (pinentry, ssh-askpass, ...) the prompt steals focus and the
 * popup is closed by the browser long before the host replies. Doing the copy
 * here means the operation still completes after the popup is gone.
 *
 * @param {string} file  Store-relative entry path
 * @param {string} field "user" or "password"
 * @return {Promise<object>} Status object from the host/copy step
 */
async function copyEntry(file, field) {
    if (typeof file !== "string" || file.length === 0) {
        throw new Error("copyEntry requires a non-empty file");
    }
    if (field !== "user" && field !== "password") {
        throw new Error("copyEntry requires field 'user' or 'password'");
    }
    const response = await sendHostRequest({ action: "fetch", file });
    if (response.status !== "ok") {
        return response;
    }
    const entry = parseEntry(response.contents);
    const value = field === "password" ? entry.password : entry.user || deriveUser(file);
    if (!value) {
        return { status: "error", message: "No " + field + " found for " + file };
    }
    await writeClipboard(value);
    return { status: "ok", field };
}

/**
 * Fetch an entry from the native host and autofill the active page's login
 * form with it.
 *
 * Like {@link copyEntry}, this lives in the background so a focus-stealing
 * passphrase prompt cannot cancel it by closing the popup.
 *
 * @param {string} file Store-relative entry path
 * @return {Promise<object>} Status object from the host/autofill step
 */
async function autofillEntry(file) {
    if (typeof file !== "string" || file.length === 0) {
        throw new Error("autofillEntry requires a non-empty file");
    }
    const response = await sendHostRequest({ action: "fetch", file });
    if (response.status !== "ok") {
        return response;
    }
    const entry = parseEntry(response.contents);
    if (!entry.password) {
        return { status: "error", message: "No password found for " + file };
    }
    return autofillPage(entry.password, entry.user || "");
}

/**
 * Copy text to the clipboard from the background context.
 *
 * The async clipboard API is tried first, but a background page is normally
 * not focused so it falls back to a synthetic `copy` event + `execCommand`,
 * which is the only reliable clipboard path outside the popup.
 *
 * @param {string} text Text to copy
 * @return {Promise<void>}
 */
async function writeClipboard(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }
    } catch (e) {
        // fall through to the execCommand fallback
    }
    const listener = (event) => {
        event.clipboardData.setData("text/plain", text);
        event.preventDefault();
    };
    document.addEventListener("copy", listener, { once: true });
    try {
        document.execCommand("copy");
    } finally {
        document.removeEventListener("copy", listener);
    }
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
