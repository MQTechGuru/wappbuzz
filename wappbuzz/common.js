/**
 * COMMON - Common Utility Functions Module
 * Provides database operations, phone number handling, and helper functions
 *
 * This module handles:
 * - MySQL database operations (query, insert, update, delete, fetch)
 * - Phone number formatting and validation
 * - File operations and MIME type detection
 * - Avatar retrieval from WhatsApp
 * - Utility functions (time, random ID generation, etc.)
 *
 * Note: This module does NOT directly use Baileys, but supports Baileys-based
 * operations through database management and utility functions
 */

const fs   = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "Config.js");

/**
 * Persist a key-value pair back into Config.js.
 * Only the `instance_id` field is expected to be written at runtime.
 *
 * @param {string} key   - The config key to update (e.g. "instance_id").
 * @param {string} value - The new value to store.
 */
function updateConfig(key, value) {
    // Read the current config object via require cache
    // Delete the cached copy so we get the latest version
    delete require.cache[require.resolve(CONFIG_PATH)];
    const config = require(CONFIG_PATH);

    // Apply the update in memory
    config[key] = value;

    // Serialise back to a JS module string
    const lines = Object.entries(config)
        .map(([k, v]) => `    ${k}:  ${JSON.stringify(v)}`)
        .join(",\n");

    const newContent =
        `/**\n` +
        ` * Config.js - Global Application Configuration\n` +
        ` *\n` +
        ` * host        : Server host (e.g. http://localhost).\n` +
        ` * port        : Server port.\n` +
        ` * access_key  : Your WappBuzz API access key (enter manually).\n` +
        ` * instance_id : Auto-populated after a successful Create Instance call.\n` +
        ` */\n\n` +
        `module.exports = {\n${lines}\n};\n`;

    fs.writeFileSync(CONFIG_PATH, newContent, "utf8");
}

module.exports = { updateConfig };