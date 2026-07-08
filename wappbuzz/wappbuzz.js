/**
 * WAPPBUZZ - WhatsApp Integration Module
 * Core module for managing WhatsApp connections using Baileys v7
 *
 * This module handles:
 * - WhatsApp socket creation and management
 * - Message sending and receiving
 * - Chatbot and autoresponder functionality
 * - Bulk messaging campaigns
 * - Session persistence and authentication
 *
 * Compatible with @whiskeysockets/baileys@^7
 */

const path         = require("path");
const fs           = require("fs");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
}                  = require("@whiskeysockets/baileys");
const { Boom }     = require("@hapi/boom");
const qrcode         = require("qrcode-terminal");
const QRCode         = require("qrcode");

const { updateConfig } = require("./common");

// ─── In-memory store ────────────────────────────────────────────────────────

/**
 * Holds the active Baileys socket and latest QR string keyed by instance_id.
 * Shape: { [instance_id]: { sock, qr, status } }
 */
const instances = {};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a random alphanumeric instance ID (13 chars, uppercase).
 * @returns {string}
 */
function generateInstanceId() {
    const chars  = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let   result = "";
    for (let i = 0; i < 13; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Session folder path for a given instance.
 * @param {string} instanceId
 * @returns {string}
 */
function sessionPath(instanceId) {
    return path.join(__dirname, "..", "sessions", instanceId);
}

// ─── Core API ────────────────────────────────────────────────────────────────

/**
 * Create a new WhatsApp instance.
 *
 * - Generates a unique instance_id.
 * - Opens a Baileys socket in the background so QR generation begins immediately.
 * - Persists the instance_id into Config.js via updateConfig().
 *
 * @returns {Promise<{ status: boolean, message: string, instance_id: string }>}
 */
async function createInstance() {
    const instanceId = generateInstanceId();
    const sessDir    = sessionPath(instanceId);

    if (!fs.existsSync(sessDir)) {
        fs.mkdirSync(sessDir, { recursive: true });
    }

    // Start the socket in the background (no await — we return immediately)
    _startSocket(instanceId).catch((err) => {
        console.error(`[WAPPBUZZ] Socket error for ${instanceId}:`, err.message);
    });

    // Persist instance_id to Config.js
    updateConfig("instance_id", instanceId);

    return {
        status:      true,
        message:     "Instance created successfully",
        instance_id: instanceId,
    };
}

/**
 * Return the current QR code for a given instance as a base64 PNG data URL.
 *
 * @param {string} instanceId
 * @returns {Promise<{ status: string, message: string, base64?: string }>}
 */
async function getQRCode(instanceId) {
    const inst = instances[instanceId];

    if (!inst) {
        return {
            status:  "error",
            message: "Instance not found.",
        };
    }

    if (!inst.qr) {
        return {
            status:  "error",
            message: "QR code not yet generated. Please retry in a moment.",
        };
    }

    // Generate PNG data URL in memory — no disk writes
    const base64 = await QRCode.toDataURL(inst.qr);

    return {
        status:  "success",
        message: "Success",
        base64,
    };
}

// ─── Internal socket management ──────────────────────────────────────────────

/**
 * Open a Baileys WebSocket for the given instance and wire up QR / disconnect handlers.
 * @param {string} instanceId
 */
async function _startSocket(instanceId) {
    const sessDir = sessionPath(instanceId);
    const { state, saveCreds } = await useMultiFileAuthState(sessDir);
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth:           state,
        printQRInTerminal: false,   // we capture it ourselves
        browser:        ["WappBuzz", "Chrome", "1.0.0"],
    });

    // Initialise in-memory record
    instances[instanceId] = { sock, qr: null, status: "connecting" };

    // ── QR event ──────────────────────────────────────────────────────────────
    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            instances[instanceId].qr = qr;
            // Optionally print to terminal for debugging
            qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
            instances[instanceId].status = "connected";
            instances[instanceId].qr     = null; // QR is no longer needed
            console.log(`[WAPPBUZZ] Instance ${instanceId} connected.`);
        }

        if (connection === "close") {
            const statusCode =
                (lastDisconnect?.error instanceof Boom)
                    ? lastDisconnect.error.output.statusCode
                    : null;

            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(
                `[WAPPBUZZ] Instance ${instanceId} disconnected (code ${statusCode}).`,
                shouldReconnect ? "Reconnecting…" : "Logged out."
            );

            if (shouldReconnect) {
                _startSocket(instanceId).catch(console.error);
            } else {
                instances[instanceId].status = "logged_out";
            }
        }
    });

    // ── Credentials persistence ───────────────────────────────────────────────
    sock.ev.on("creds.update", saveCreds);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = { createInstance, getQRCode };