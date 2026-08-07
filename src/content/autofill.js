"use strict";

const PASSWORD_HINT = ["password"];
const LOGIN_HINT = ["user", "login"];
const LOGIN_TYPES = ["email", "text"];

browser.runtime.onMessage.addListener((message) => {
    if (!message || message.action !== "autofill") {
        return;
    }
    return autofill(message.password, message.user);
});

/**
 * Fill the page form with the given credentials. Finds a password field (an
 * `input[type="password"]` or any input whose tag/attributes mention
 * "password") and a login field (`input[type="email"]` or
 * `input[type="text"]` whose tag/attributes mention "user" or "login").
 *
 * @param {string} password Password to fill
 * @param {string} user     Username to fill, may be empty
 * @return {{status: string, message?: string, fields?: string[]}} Result
 */
function autofill(password, user) {
    const passwordInput = findPasswordInput();
    if (!passwordInput) {
        return { status: "error", message: "No password field found on the page" };
    }
    const filled = ["password"];
    setFieldValue(passwordInput, password);
    if (user) {
        const userInput = findLoginInput();
        if (userInput) {
            setFieldValue(userInput, user);
            filled.push("user");
        }
    }
    return { status: "ok", fields: filled };
}

/**
 * Find the first input that looks like a password field: an input of type
 * password, or any input whose tag name or attributes contain the word
 * "password".
 *
 * @return {HTMLInputElement|null} Matching input or null
 */
function findPasswordInput() {
    for (const input of document.querySelectorAll("input")) {
        const type = (input.type || "").toLowerCase();
        if (type === "password" || signature(input).includes("password")) {
            return input;
        }
    }
    return null;
}

/**
 * Find the first input that looks like a login field: an input of type email
 * or text whose tag name or attributes contain the word "user" or "login".
 *
 * @return {HTMLInputElement|null} Matching input or null
 */
function findLoginInput() {
    for (const input of document.querySelectorAll("input")) {
        const type = (input.type || "").toLowerCase();
        if (!LOGIN_TYPES.includes(type)) {
            continue;
        }
        const sig = signature(input);
        if (LOGIN_HINT.some((hint) => sig.includes(hint))) {
            return input;
        }
    }
    return null;
}

/**
 * Build a lower-cased signature of an input: its tag name plus every attribute
 * name and value (e.g. id, name, class, placeholder, autocomplete, aria-label,
 * data-*).
 *
 * @param {HTMLInputElement} input Input element
 * @return {string} Lower-cased signature
 */
function signature(input) {
    const parts = [input.tagName];
    for (const attr of input.attributes) {
        parts.push(attr.name, attr.value);
    }
    return parts.join(" ").toLowerCase();
}

/**
 * Set an input's value and dispatch `input` and `change` events so framework
 * bindings (React, Vue, etc.) pick it up. Uses the native value setter to
 * bypass any value-overriding libraries.
 *
 * @param {HTMLInputElement} input Input element
 * @param {string}           value Value to set
 * @return {void}
 */
function setFieldValue(input, value) {
    const proto =
        input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    if (setter) {
        setter.call(input, value);
    } else {
        input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
}
