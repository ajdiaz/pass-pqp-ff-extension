"use strict";

// Native messaging host name; must match the "name" field of the installed
// native messaging manifest (see native/pass-pqp-host.json.in).
const HOST_NAME = "pass_pqp_host";

// Default extension settings. Empty strings mean "use the native host
// default" (environment variable or built-in default).
const DEFAULT_SETTINGS = {
    passPqpBin: "",
    pqpBin: "",
    passwordTool: "",
    passwordStoreDir: "",
    noPassphrase: true,
};

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
        sendResponse(response);
    } catch (e) {
        sendResponse({ status: "error", message: e.message });
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
