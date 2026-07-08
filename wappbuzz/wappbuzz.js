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

/**
 * Send a text message via an existing WhatsApp instance.
 *
 * The destination JID is resolved automatically:
 *   - If `number` already contains "@" it is used as-is (group / full JID).
 *   - Otherwise "@s.whatsapp.net" is appended (individual number).
 *
 * @param {string} instanceId  - The instance_id from Config.js.
 * @param {string} number      - Destination number or group JID.
 * @param {string} message     - Plain-text message to send.
 * @returns {Promise<{ status: string, message: string, data?: object }>}
 */
async function sendTextMessage(instanceId, number, message) {
    const inst        = instances[instanceId];
    const memoryKeys  = Object.keys(instances);

    // ── Debug: full diagnostic trace ─────────────────────────────────────────
    console.log(`[WAPPBUZZ][DEBUG] sendTextMessage called with instance_id="${instanceId}"`);
    console.log(`[WAPPBUZZ][DEBUG] instances in memory: [${memoryKeys.join(", ") || "none"}]`);
    console.log(`[WAPPBUZZ][DEBUG] instance found in memory: ${!!inst}`);

    if (inst) {
        const wsState      = inst.sock?.ws?.readyState;
        const wsStateNames = { 0: "CONNECTING", 1: "OPEN", 2: "CLOSING", 3: "CLOSED" };
        console.log(`[WAPPBUZZ][DEBUG] status            : "${inst.status}"`);
        console.log(`[WAPPBUZZ][DEBUG] socket exists     : ${!!inst.sock}`);
        console.log(`[WAPPBUZZ][DEBUG] socket.user       : ${JSON.stringify(inst.sock?.user ?? null)}`);
        console.log(`[WAPPBUZZ][DEBUG] socket.ws.readyState: ${wsState} (${wsStateNames[wsState] ?? "UNKNOWN"})`);
    } else {
        console.warn(
            `[WAPPBUZZ][DEBUG] ROOT CAUSE: instance_id "${instanceId}" is NOT in the in-memory store.\n` +
            `  Possible reason: server was restarted after the QR was scanned.\n` +
            `  The in-memory 'instances' object is cleared on every server restart.\n` +
            `  The saved session in sessions/${instanceId}/ exists on disk but has NOT been\n` +
            `  loaded back into memory yet. Call restoreInstance() on startup to fix this.`
        );
    }

    // ── Guard: instance must exist and be connected ──────────────────────────
    if (!inst || inst.status !== "connected") {
        const reason = !inst
            ? `Instance "${instanceId}" not found in memory (server may have been restarted — socket not restored yet).`
            : `Instance status is "${inst.status}", expected "connected".`;
        console.warn(`[WAPPBUZZ] sendTextMessage: BLOCKED — ${reason}`);
        return {
            status:  "error",
            message: "WhatsApp is not connected.",
        };
    }

    // ── Resolve JID ──────────────────────────────────────────────────────────
    const jid = number.includes("@") ? number : `${number}@s.whatsapp.net`;
    console.log(`[WAPPBUZZ] sendTextMessage: sending to ${jid} via instance ${instanceId}`);

    // ── Send via Baileys ─────────────────────────────────────────────────────
    const sent = await inst.sock.sendMessage(jid, { text: message });

    const messageId = sent?.key?.id ?? null;
    const timestamp = sent?.messageTimestamp
        ? Number(sent.messageTimestamp)
        : Math.floor(Date.now() / 1000);

    console.log(`[WAPPBUZZ] sendTextMessage: sent. message_id=${messageId} timestamp=${timestamp}`);

    return {
        status:  "success",
        message: "Message sent successfully.",
        data: {
            number,
            type:       "text",
            message_id: messageId,
            timestamp,
        },
    };
}

/**
 * Restore a previously authenticated WhatsApp instance from saved session files.
 *
 * This is called once on server startup to reload any instance whose credentials
 * were persisted to disk in a previous server process. Baileys reads creds.json
 * from the session folder and reconnects automatically — no QR code is emitted,
 * no new instance is created, no manual reconnection is needed.
 *
 * Has no effect if:
 *   - instanceId is empty / null
 *   - The instance is already loaded in memory
 *   - No session folder exists for this instanceId
 *
 * @param {string} instanceId - The instance_id from Config.js.
 */
function restoreInstance(instanceId) {
    if (!instanceId) {
        console.log("[WAPPBUZZ] restoreInstance: no instance_id configured, skipping.");
        return;
    }

    // Already in memory — nothing to do
    if (instances[instanceId]) {
        console.log(`[WAPPBUZZ] restoreInstance: instance "${instanceId}" is already in memory (status: ${instances[instanceId].status}), skipping.`);
        return;
    }

    // Session folder must exist (i.e. QR was scanned in a prior server process)
    const sessDir = sessionPath(instanceId);
    if (!fs.existsSync(sessDir)) {
        console.log(`[WAPPBUZZ] restoreInstance: no session folder found for "${instanceId}", skipping.`);
        return;
    }

    console.log(`[WAPPBUZZ] restoreInstance: session found on disk for "${instanceId}" — loading saved credentials...`);

    // Start the socket using saved creds — Baileys will NOT emit a QR code
    // if creds.json is valid; it reconnects silently and fires connection="open".
    _startSocket(instanceId).catch((err) => {
        console.error(`[WAPPBUZZ] restoreInstance: failed to restore "${instanceId}":`, err.message);
    });
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

module.exports = { createInstance, getQRCode, sendTextMessage, restoreInstance };