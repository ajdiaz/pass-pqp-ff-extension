"use strict";

// Native messaging host name; must match the "name" field of the installed
// native messaging manifest (see native/pass-pqp-host.json.in).
const HOST_NAME = "pass_pqp_host";

// Route messages coming from the popup to the native messaging host.
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sendResponse);
    // keep the response channel open for the async work above
    return true;
});

/**
 * Handle a single message from the popup.
 *
 * @param {object}   message      Message from the popup
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
            default:
                throw new Error("Unknown action: " + message.action);
        }
        sendResponse(response);
    } catch (e) {
        sendResponse({ status: "error", message: e.message });
    }
}

/**
 * Send a request to the native messaging host and normalize the response.
 *
 * @param {object} request Request object for the native host
 * @return {object} Response from the host
 */
async function sendHostRequest(request) {
    try {
        const response = await browser.runtime.sendNativeMessage(HOST_NAME, request);
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
