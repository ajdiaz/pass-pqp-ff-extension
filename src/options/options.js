"use strict";

const $ = (id) => document.getElementById(id);

let saveTimer = null;

init();

/**
 * Load the current configuration and host status on page load.
 *
 * @return {Promise<void>}
 */
async function init() {
    try {
        const response = await browser.runtime.sendMessage({ action: "getConfig" });
        if (response.status !== "ok") {
            showError(response.message);
            return;
        }
        $("passPqpBin").value = response.settings.passPqpBin;
        $("pqpBin").value = response.settings.pqpBin;
        $("passwordStoreDir").value = response.settings.passwordStoreDir;
        $("noPassphrase").checked = response.settings.noPassphrase;
        $("passwordTool").value = response.settings.passwordTool;
        syncPasswordToolField();
        renderHostInfo(response.host);
    } catch (e) {
        showError(e.message);
    }
    $("noPassphrase").addEventListener("change", syncPasswordToolField);
    $("save").addEventListener("click", saveConfig);
}

/**
 * Enable the password tool field only when no-passphrase decryption is off.
 *
 * @return {void}
 */
function syncPasswordToolField() {
    $("passwordTool").disabled = $("noPassphrase").checked;
}

/**
 * Save the form values and refresh the host status with the new config.
 *
 * @return {Promise<void>}
 */
async function saveConfig() {
    const settings = {
        passPqpBin: $("passPqpBin").value.trim(),
        pqpBin: $("pqpBin").value.trim(),
        passwordStoreDir: $("passwordStoreDir").value.trim(),
        noPassphrase: $("noPassphrase").checked,
        passwordTool: $("passwordTool").value,
    };
    if (!settings.noPassphrase && !settings.passwordTool) {
        showError(
            "Either enable \u201cDecrypt without a passphrase prompt\u201d or select a password tool \u2014 one of the two is mandatory."
        );
        setSaveStatus("");
        return;
    }
    setSaveStatus("Saving\u2026");
    try {
        const response = await browser.runtime.sendMessage({
            action: "saveConfig",
            settings,
        });
        if (response.status !== "ok") {
            showError(response.message);
            setSaveStatus("");
            return;
        }
        renderHostInfo(response.host);
        setSaveStatus("Saved");
    } catch (e) {
        showError(e.message);
        setSaveStatus("");
    }
}

/**
 * Render the host status section from a configure probe.
 *
 * @param {object} host Host probe response
 * @return {void}
 */
function renderHostInfo(host) {
    if (!host || host.status !== "ok") {
        const message = host && host.message ? host.message : "Host not reachable";
        $("hostError").textContent = message;
        $("hostError").hidden = false;
        $("hostVersion").textContent = "\u2014";
        $("hostStoreDir").textContent = "\u2014";
        $("hostBinary").textContent = "\u2014";
        $("hostPqpBinary").textContent = "\u2014";
        $("hostPasswordTool").textContent = "\u2014";
        $("hostStoreExists").textContent = "\u2014";
        $("hostNoPassphrase").textContent = "\u2014";
        return;
    }
    $("hostError").hidden = true;
    $("hostVersion").textContent = host.version;
    $("hostStoreDir").textContent = host.storeDir;
    $("hostBinary").textContent = host.passPqpBin || "\u2014";
    $("hostPqpBinary").textContent = host.pqpBin || "\u2014";
    $("hostPasswordTool").textContent = host.passwordTool || "\u2014";
    $("hostStoreExists").textContent = host.storeExists ? "yes" : "no";
    $("hostNoPassphrase").textContent = host.noPassphrase ? "on" : "off";
}

/**
 * Show a transient save status message.
 *
 * @param {string} message Message text
 * @return {void}
 */
function setSaveStatus(message) {
    const status = $("saveStatus");
    if (!message) {
        status.hidden = true;
        status.textContent = "";
        return;
    }
    status.textContent = message;
    status.hidden = false;
    if (saveTimer) {
        clearTimeout(saveTimer);
    }
    if (message !== "Saving\u2026") {
        saveTimer = setTimeout(() => {
            status.hidden = true;
        }, 2500);
    }
}

/**
 * Show a persistent error message.
 *
 * @param {string} message Message text
 * @return {void}
 */
function showError(message) {
    const error = $("hostError");
    error.textContent = message;
    error.hidden = false;
}
