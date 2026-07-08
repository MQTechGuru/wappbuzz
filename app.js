/**
 * WappBuzz - WhatsApp Automation Platform
 * Main application entry point that defines API routes for WhatsApp instance management
 * Compatible with Baileys v7 (@whiskeysockets/baileys)
 */

// ── Imports ──────────────────────────────────────────────────────────────────

const express    = require("express");
const path       = require("path");
const WAPPBUZZ   = require("./wappbuzz/wappbuzz");

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Helper ───────────────────────────────────────────────────────────────────

/**
 * Load the freshest copy of Config.js (bypasses require cache so runtime
 * writes by updateConfig() are visible immediately).
 * @returns {{ host: string, port: number, access_key: string, instance_id: string }}
 */
function freshConfig() {
    const configPath = require.resolve("./Config.js");
    delete require.cache[configPath];
    return require(configPath);
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/create_instance
 *
 * Creates a new WhatsApp instance using the access_key stored in Config.js.
 * If an instance_id already exists in Config.js it is returned directly
 * unless ?force=true is passed.
 *
 * Query params:
 *   access_token  (required) — must match Config.js access_key
 *   force         (optional) — set to "true" to force recreation
 */
app.post("/api/create_instance", async (req, res) => {
    try {
        const config                  = freshConfig();
        const { access_token, force } = req.query;

        // ── Validate access_token ──────────────────────────────────────────────────
        if (!access_token || access_token !== config.access_key) {
            return res.status(401).json({
                status:  "error",
                message: "Invalid access key.",
            });
        }

        // ── Return existing instance unless force recreation requested ──────────
        if (config.instance_id && force !== "true") {
            const qr_code_url = `${config.host}:${config.port}/api/get_qrcode?access_token=${config.access_key}&instance_id=${config.instance_id}`;
            return res.json({
                status:  "success",
                message: "Instance already exists.",
                data: {
                    instance_id: config.instance_id,
                    qr_code_url,
                    next_step: "Scan the QR code with your WhatsApp mobile app to connect",
                },
            });
        }

        // ── Create a new instance ───────────────────────────────────────────────
        const result    = await WAPPBUZZ.createInstance();
        // Re-read config so we pick up the freshly written instance_id
        const newConfig = freshConfig();
        const qr_code_url = `${newConfig.host}:${newConfig.port}/api/get_qrcode?access_token=${newConfig.access_key}&instance_id=${result.instance_id}`;

        return res.json({
            status:  "success",
            message: "Instance created successfully",
            data: {
                instance_id: result.instance_id,
                qr_code_url,
                next_step: "Scan the QR code with your WhatsApp mobile app to connect",
            },
        });

    } catch (err) {
        console.error("[/api/create_instance] Error:", err.message);
        return res.status(500).json({
            status:  "error",
            message: "Failed to create instance.",
            error:   err.message,
        });
    }
});

/**
 * GET /api/get_qrcode
 *
 * Returns the QR code (as a base64 PNG data URL) for the stored instance.
 *
 * Query params:
 *   instance_id   (required) — must match Config.js instance_id
 *   access_token  (required) — must match Config.js access_key
 */
app.get("/api/get_qrcode", async (req, res) => {
    try {
        const config = freshConfig();
        const { instance_id, access_token } = req.query;

        // ── Validate access_key ────────────────────────────────────────────────
        if (!access_token || access_token !== config.access_key) {
            return res.status(401).json({
                status:  "error",
                message: "Invalid access key.",
            });
        }

        // ── Check that an instance exists in Config ─────────────────────────────
        if (!config.instance_id) {
            return res.json({
                status:  "error",
                message: "Instance not found.",
            });
        }

        // ── Validate provided instance_id matches stored one ──────────────────
        if (!instance_id || instance_id !== config.instance_id) {
            return res.json({
                status:  "error",
                message: "Instance not found.",
            });
        }

        // ── Fetch QR as base64 PNG ────────────────────────────────────────────
        const result = await WAPPBUZZ.getQRCode(instance_id);
        return res.json(result);

    } catch (err) {
        console.error("[/api/get_qrcode] Error:", err.message);
        return res.status(500).json({
            status:  "error",
            message: "Failed to retrieve QR code.",
            error:   err.message,
        });
    }
});

/**
 * POST /api/send
 *
 * Sends a text message via an existing, connected WhatsApp instance.
 *
 * Body (application/json):
 *   number       (required) — Destination number (e.g. 917357935653) or group JID
 *   type         (required) — Must be "text"
 *   message      (required) — Text message to send
 *   instance_id  (required) — Must match Config.js instance_id
 *   access_token (required) — Must match Config.js access_key
 */
app.post("/api/send", async (req, res) => {
    console.log("[/api/send] Request received.");

    try {
        const config = freshConfig();
        const { number, type, message, instance_id, access_token } = req.body;

        // ── Validate required fields ───────────────────────────────────────────
        if (!number || !type || !message || !instance_id || !access_token) {
            console.warn("[/api/send] Validation failed: missing required parameters.");
            return res.status(400).json({
                status:  "error",
                message: "Required parameters are missing.",
            });
        }

        // ── Validate type ─────────────────────────────────────────────────────
        if (type !== "text") {
            console.warn(`[/api/send] Validation failed: unsupported type "${type}".`);
            return res.status(400).json({
                status:  "error",
                message: "Unsupported message type.",
            });
        }

        // ── Authenticate access_token ──────────────────────────────────────────
        if (access_token !== config.access_key) {
            console.warn("[/api/send] Authentication failed: invalid access token.");
            return res.status(401).json({
                status:  "error",
                message: "Invalid access token.",
            });
        }

        // ── Authenticate instance_id ───────────────────────────────────────────
        if (instance_id !== config.instance_id) {
            console.warn(`[/api/send] Authentication failed: invalid instance ID "${instance_id}".`);
            return res.status(401).json({
                status:  "error",
                message: "Invalid instance ID.",
            });
        }

        console.log(`[/api/send] Validation passed. Destination: ${number}`);

        // ── Send message ───────────────────────────────────────────────────────
        const result = await WAPPBUZZ.sendTextMessage(instance_id, number, message);

        if (result.status === "error") {
            // WhatsApp not connected or send failed
            const httpStatus = result.message === "WhatsApp is not connected." ? 503 : 500;
            console.error(`[/api/send] Send failed: ${result.message}`);
            return res.status(httpStatus).json(result);
        }

        console.log(`[/api/send] Success. message_id=${result.data.message_id} timestamp=${result.data.timestamp}`);
        return res.json(result);

    } catch (err) {
        console.error("[/api/send] Unexpected error:", err.message);
        return res.status(500).json({
            status:  "error",
            message: "Failed to send message.",
            reason:  err.message,
        });
    }
});

// ── Start server ──────────────────────────────────────────────────────────────

app.listen(PORT, () => {
    console.log(`[WappBuzz] Server running on http://localhost:${PORT}`);

    // ── Restore saved WhatsApp session on startup ──────────────────────────────
    //
    // When the server restarts the in-memory `instances` object is empty, but
    // the Baileys session files (creds.json, etc.) are still on disk.
    // restoreInstance() calls _startSocket() with the saved credentials so
    // Baileys can reconnect silently — no QR code, no new instance.
    //
    const startupConfig = freshConfig();
    if (startupConfig.instance_id) {
        console.log(`[WappBuzz] Startup: restoring instance "${startupConfig.instance_id}" from saved session...`);
        WAPPBUZZ.restoreInstance(startupConfig.instance_id);
    } else {
        console.log("[WappBuzz] Startup: no instance_id in Config.js, skipping session restore.");
    }
});

module.exports = app;
