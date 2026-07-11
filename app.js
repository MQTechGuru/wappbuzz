/**
 * WappBuzz - WhatsApp Automation Platform
 * Main application entry point that defines API routes for WhatsApp instance management
 * Compatible with Baileys v7 (@whiskeysockets/baileys)
 */

// ── Imports ──────────────────────────────────────────────────────────────────

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const path       = require("path");
const WAPPBUZZ   = require("./wappbuzz/wappbuzz");
const config     = require("./Config");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
});
const PORT   = process.env.PORT || config.port;

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

/**
 * Unifies request authorization across all APIs.
 * Validates access_token against wb_team.ids.
 */
async function authorizeRequest(req, res) {
    const access_token = req.query?.access_token ?? req.body?.access_token;

    if (!access_token) {
        res.status(401).json({
            status: "error",
            message: "Invalid access key."
        });
        return null;
    }

    const config = freshConfig();
    const prefix = config.prefix || "wb_";
    const db = require("./wappbuzz/db");

    try {
        const teams = await db.query(`SELECT COUNT(*) as count FROM \`${prefix}team\` WHERE ids = ?`, [access_token]);
        const authorized = teams[0].count > 0;

        if (!authorized) {
            res.status(401).json({
                status: "error",
                message: "Invalid access key."
            });
            return null;
        }

        return access_token;
    } catch (e) {
        console.error("Authorization database query error:", e.message);
        res.status(401).json({
            status: "error",
            message: "Invalid access key."
        });
        return null;
    }
}

/**
 * Validate instance_id against database
 */
async function isValidInstanceId(instanceId) {
    if (!instanceId) return false;
    const config = freshConfig();
    const prefix = config.prefix || "wb_";
    const db = require("./wappbuzz/db");
    try {
        const sessions = await db.query(`SELECT COUNT(*) as count FROM \`${prefix}whatsapp_sessions\` WHERE instance_id = ?`, [instanceId]);
        return sessions[0].count > 0;
    } catch (e) {
        console.error("[Database System] Error validating instance ID:", e.message);
        return false;
    }
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
async function handleCreateInstance(req, res) {
    try {
        const config = freshConfig();

        // ── Validate access_token ──────────────────────────────────────────────────
        const access_token = await authorizeRequest(req, res);
        if (!access_token) return;

        // ── Create a new instance ───────────────────────────────────────────────
        const result = await WAPPBUZZ.createInstance();
        const qr_code_url = `${config.host}:${config.port}/api/get_qrcode?access_token=${access_token}&instance_id=${result.instance_id}`;

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
}

app.get("/api/create_instance", handleCreateInstance);
app.post("/api/create_instance", handleCreateInstance);

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
        const { instance_id } = req.query;

        // ── Validate access_token ────────────────────────────────────────────────
        const access_token = await authorizeRequest(req, res);
        if (!access_token) return;

        // ── Validate provided instance_id exists in the database ───────────────
        const isValidId = await isValidInstanceId(instance_id);
        if (!isValidId) {
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
        // ── Authenticate access_token ──────────────────────────────────────────
        const authorized_token = await authorizeRequest(req, res);
        if (!authorized_token) return;

        // ── Authenticate instance_id ───────────────────────────────────────────
        const isValidId = await isValidInstanceId(instance_id);
        if (!isValidId) {
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

/**
 * POST /api/reboot
 *
 * Logs out and performs complete cleanup of the specified WhatsApp instance.
 *
 * Body (application/json):
 *   instance_id   (required) — Must match the session's instance_id
 *   access_token  (required) — Must match access_key permissions
 */
app.post("/api/reboot", async (req, res) => {
    console.log("[/api/reboot] Request received.");
    try {
        const { instance_id } = req.body;

        // ── Validate access_token ──────────────────────────────────────────
        const authorized_token = await authorizeRequest(req, res);
        if (!authorized_token) return;

        // ── Authenticate instance_id ───────────────────────────────────────────
        const isValidId = await isValidInstanceId(instance_id);
        if (!isValidId) {
            console.warn(`[/api/reboot] Authentication failed: invalid instance ID "${instance_id}".`);
            return res.status(401).json({
                status:  "error",
                message: "Invalid instance ID.",
            });
        }

        // Perform the full cleanup process
        await WAPPBUZZ.cleanupInstance(instance_id);

        return res.json({
            status: "success",
            message: "Instance rebooted and cleaned up successfully."
        });

    } catch (err) {
        console.error("[/api/reboot] Unexpected error:", err.message);
        return res.status(500).json({
            status:  "error",
            message: "Failed to reboot instance.",
            reason:  err.message,
        });
    }
});

/**
 * POST /api/reset_instance
 *
 * Completely resets a WhatsApp instance: logs out, deletes session folder,
 * deletes the old database entries, generates a new Instance ID, saves it
 * in the database, and returns the new instance information.
 *
 * Body (application/json):
 *   instance_id   (required) — The current instance_id
 *   access_token  (required) — Authorization access token
 */
app.post("/api/reset_instance", async (req, res) => {
    console.log("[/api/reset_instance] Request received.");
    try {
        const { instance_id } = req.body;

        // ── Validate access_token ──────────────────────────────────────────
        const authorized_token = await authorizeRequest(req, res);
        if (!authorized_token) return;

        // ── Authenticate instance_id ───────────────────────────────────────────
        const isValidId = await isValidInstanceId(instance_id);
        if (!isValidId) {
            console.warn(`[/api/reset_instance] Authentication failed: invalid instance ID "${instance_id}".`);
            return res.status(401).json({
                status:  "error",
                message: "Invalid instance ID.",
            });
        }

        // 1. Perform complete cleanup (closes socket, removes listeners, deletes memory/folder)
        await WAPPBUZZ.cleanupInstance(instance_id);

        // 2. Completely delete the database rows for the old session/account
        const config = freshConfig();
        const prefix = config.prefix || "wb_";
        const db = require("./wappbuzz/db");
        await db.query(`DELETE FROM \`${prefix}whatsapp_sessions\` WHERE instance_id = ?`, [instance_id]);
        await db.query(`DELETE FROM \`${prefix}accounts\` WHERE token = ?`, [instance_id]);

        // 3. Create a brand-new instance ID and background socket
        const result = await WAPPBUZZ.createInstance();

        return res.json({
            status: "success",
            message: "Instance reset successfully.",
            data: {
                instance_id: result.instance_id,
                next_step: "Generate a new QR Code."
            }
        });

    } catch (err) {
        console.error("[/api/reset_instance] Unexpected error:", err.message);
        return res.status(500).json({
            status:  "error",
            message: "Failed to reset instance.",
            reason:  err.message,
        });
    }
});

/**
 * POST /api/reconnect
 *
 * Reconnects an existing instance without generating a new Instance ID.
 *
 * Body (application/json):
 *   instance_id   (required) — The current instance_id
 *   access_token  (required) — Authorization access token
 */
app.post("/api/reconnect", async (req, res) => {
    console.log("[/api/reconnect] Request received.");
    try {
        const { instance_id } = req.body;

        // ── Validate access_token ──────────────────────────────────────────
        const authorized_token = await authorizeRequest(req, res);
        if (!authorized_token) return;

        // ── Authenticate instance_id ───────────────────────────────────────────
        const isValidId = await isValidInstanceId(instance_id);
        if (!isValidId) {
            console.warn(`[/api/reconnect] Authentication failed: invalid instance ID "${instance_id}".`);
            return res.status(401).json({
                status:  "error",
                message: "Invalid instance ID.",
            });
        }

        // Recreate the socket connection reusing existing session files
        await WAPPBUZZ.reconnectInstance(instance_id);

        return res.json({
            status: "success",
            message: "Reconnect process started."
        });

    } catch (err) {
        console.error("[/api/reconnect] Unexpected error:", err.message);
        return res.status(500).json({
            status:  "error",
            message: "Failed to reconnect instance.",
            reason:  err.message,
        });
    }
});

// ── Health Check handler ──────────────────────────────────────────────────────

/**
 * Core health check logic — used by POST /api/health.
 *
 * 1. Validates access_token and instance_id against Config.js.
 * 2. Calls WAPPBUZZ.getInstanceHealth() to inspect the in-memory socket.
 * 3. Emits a realtime Socket.IO event "instance_health" to all connected clients.
 * 4. Returns the structured HTTP response.
 *
 * Does NOT create a socket, reconnect, or generate a QR code.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
async function handleHealthCheck(req, res) {
    console.log(`[/api/health] Request received (${req.method}).`);

    try {
        const config = freshConfig();

        // ── Read params from query string (GET) or body (POST) ────────────────
        const instance_id  = req.query.instance_id  ?? req.body?.instance_id;
        const access_token = req.query.access_token ?? req.body?.access_token;

        // ── Validate required params ───────────────────────────────────────────
        if (!instance_id || !access_token) {
            console.warn("[/api/health] Missing required parameters.");
            return res.status(400).json({
                status:  "error",
                message: "Required parameters are missing.",
            });
        }

        // ── Authenticate access_token ──────────────────────────────────────────
        const authorized_token = await authorizeRequest(req, res);
        if (!authorized_token) return;

        // ── Authenticate instance_id ───────────────────────────────────────────
        const isValidId = await isValidInstanceId(instance_id);
        if (!isValidId) {
            console.warn(`[/api/health] Authentication failed: invalid instance ID "${instance_id}".`);
            return res.status(401).json({
                status:  "error",
                message: "Invalid instance ID.",
            });
        }

        // ── Inspect instance health ────────────────────────────────────────────
        const h = WAPPBUZZ.getInstanceHealth(instance_id);

        // ── Socket.IO connected clients count ──────────────────────────────────
        const ioClients   = io.engine.clientsCount;
        const socketIoStr = ioClients > 0 ? "connected" : "no clients";
        console.log(`[/api/health] Socket.IO connected clients: ${ioClients}`);

        // ── No active session on disk ──────────────────────────────────────────
        if (!h.sessionOnDisk) {
            io.emit("instance_health", { instance_id, status: "disconnected" });
            return res.status(404).json({
                status:  "error",
                message: "No active session found.",
            });
        }

        const timestamp = Math.floor(Date.now() / 1000);

        // ── Connected ──────────────────────────────────────────────────────────────
        //
        // ROOT CAUSE FIX: the previous condition used h.wsReadyState === 1
        // (WebSocket OPEN state). In Baileys v7 sock.ws is a custom wrapper whose
        // readyState is undefined/non-standard, so the check always failed even
        // when WhatsApp is fully connected.
        //
        // The correct authoritative source of truth is h.wsIsOpen which is derived
        // from inst.status === "connected" — set by the Baileys connection.update
        // event when connection === "open". This is 100% reliable.
        //
        if (h.wsIsOpen && h.socketExists) {
            io.emit("instance_health", {
                instance_id,
                status:    "connected",
                phone:     h.phone,
                push_name: h.pushName,
            });

            console.log(`[/api/health] Result: CONNECTED | phone=${h.phone} | push_name=${h.pushName}`);

            return res.json({
                status:  "success",
                message: "WhatsApp is connected.",
                data: {
                    instance_id,
                    phone:       h.phone,
                    push_name:   h.pushName,
                    connection:  "connected",
                    platform:    h.platform ?? "unknown",
                    socket:      "connected",
                    socket_io:   socketIoStr,
                    timestamp,
                },
            });
        }

        // ── Disconnected (session exists but socket not open) ──────────────────
        io.emit("instance_health", { instance_id, status: "disconnected" });

        console.log(`[/api/health] Result: DISCONNECTED | status=${h.status} | ws=${h.wsReadyStateName}`);

        return res.status(503).json({
            status:  "error",
            message: "WhatsApp is disconnected.",
            data: {
                connection: "disconnected",
                socket:     h.socketExists ? h.wsReadyStateName.toLowerCase() : "disconnected",
                socket_io:  socketIoStr,
            },
        });

    } catch (err) {
        console.error("[/api/health] Unexpected error:", err.message);
        return res.status(500).json({
            status:  "error",
            message: "Health check failed.",
            reason:  err.message,
        });
    }
}

/**
 * POST /api/health
 *
 * Health check via JSON body.
 *
 * Body (application/json):
 *   instance_id   (required) — must match Config.js instance_id
 *   access_token  (required) — must match Config.js access_key
 */
app.post("/api/health", handleHealthCheck);

// ── Socket.IO ─────────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
    console.log(`[Socket.IO] Client connected: ${socket.id} | total=${io.engine.clientsCount}`);

    socket.on("disconnect", () => {
        console.log(`[Socket.IO] Client disconnected: ${socket.id} | total=${io.engine.clientsCount}`);
    });
});

// ── Start server ──────────────────────────────────────────────────────────────

server.listen(PORT, () => {
    console.log(`[WappBuzz] Server running on http://localhost:${PORT}`);

    // Initialize the MySQL database system and execute seeding
    const db = require("./wappbuzz/db");
    const seed = require("./database/seed");
    
    db.initialize()
        .then(async () => {
            console.log("──────────────────────────────");
            console.log("✓ Database Connected");
            console.log("✓ Running Database Seed...");
            
            // Run the transaction-safe seeding process
            await seed.runDatabaseSeed(db.getPool());
            
            console.log("✓ Database Seed Completed");
            console.log("──────────────────────────────");

            // Restore saved WhatsApp sessions on startup from the database
            try {
                const startupConfig = freshConfig();
                const prefix = startupConfig.prefix || "wb_";
                const sessions = await db.query(`SELECT instance_id FROM \`${prefix}whatsapp_sessions\``);
                if (sessions.length > 0) {
                    for (const session of sessions) {
                        console.log(`[WappBuzz] Startup: restoring instance "${session.instance_id}" from saved session...`);
                        WAPPBUZZ.restoreInstance(session.instance_id);
                    }
                } else {
                    console.log("[WappBuzz] Startup: no sessions found in database, skipping session restore.");
                }
            } catch (dbErr) {
                console.error("[WappBuzz] Startup: failed to load sessions from database for restoration:", dbErr.message);
            }
        })
        .catch((err) => {
            console.error("[Database System] Initialization/Seeding failed. Server running but DB features will be unavailable:", err.message);
        });
});

module.exports = { app, io, server };
