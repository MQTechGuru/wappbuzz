const mysql = require("mysql");
const fs = require("fs");
const path = require("path");

// Resolve configuration dynamically to pick up updates
function getConfig() {
    const configPath = require.resolve("../Config");
    delete require.cache[configPath];
    return require(configPath);
}

let pool = null;

/**
 * Retrieve the active MySQL connection pool
 */
function getPool() {
    if (!pool) {
        const config = getConfig();
        pool = mysql.createPool({
            connectionLimit: config.database.connectionLimit,
            host: config.database.host,
            user: config.database.user,
            password: config.database.password,
            database: config.database.database,
            charset: config.database.charset,
            debug: config.database.debug,
            waitForConnections: config.database.waitForConnections,
            multipleStatements: config.database.multipleStatements
        });

        pool.on('error', (err) => {
            console.error('[MySQL Pool Error]', err.message);
        });
    }
    return pool;
}

/**
 * Execute an SQL query using connection pool and return a Promise
 */
function query(sql, params = []) {
    return new Promise((resolve, reject) => {
        getPool().query(sql, params, (err, results) => {
            if (err) return reject(err);
            resolve(results);
        });
    });
}

/**
 * Automatically check and initialize the database and tables
 */
async function initialize() {
    const config = getConfig();
    const dbConfig = config.database;
    const prefix = config.prefix || "wb_";

    // 1. Check and create database using a temporary connection (without database property)
    let tempConn;
    try {
        tempConn = mysql.createConnection({
            host: dbConfig.host,
            user: dbConfig.user,
            password: dbConfig.password,
            charset: dbConfig.charset
        });

        await new Promise((resolve, reject) => {
            tempConn.connect((err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        await new Promise((resolve, reject) => {
            tempConn.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET ${dbConfig.charset} COLLATE utf8mb4_general_ci`, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    } catch (err) {
        if (tempConn) {
            try { tempConn.end(); } catch (e) {}
        }
        throw err;
    } finally {
        if (tempConn) {
            try { tempConn.end(); } catch (e) {}
        }
    }

    // 2. Initialize pool and check/create tables
    try {
        // Create tables using InnoDB + utf8mb4
        await query(`
            CREATE TABLE IF NOT EXISTS \`${prefix}users\` (
              \`id\` int(11) NOT NULL AUTO_INCREMENT,
              \`ids\` mediumtext DEFAULT NULL,
              \`pid\` text DEFAULT NULL,
              \`is_admin\` int(1) DEFAULT NULL,
              \`role\` int(11) DEFAULT NULL,
              \`fullname\` varchar(255) DEFAULT NULL,
              \`username\` varchar(255) DEFAULT NULL,
              \`email\` varchar(255) DEFAULT NULL,
              \`whatsapp\` varchar(255) DEFAULT NULL,
              \`password\` varchar(255) DEFAULT NULL,
              \`plan\` int(11) DEFAULT NULL,
              \`expiration_date\` int(11) DEFAULT NULL,
              \`timezone\` mediumtext DEFAULT NULL,
              \`language\` varchar(30) DEFAULT NULL,
              \`login_type\` mediumtext DEFAULT NULL,
              \`avatar\` varchar(255) DEFAULT NULL,
              \`data\` mediumtext DEFAULT NULL,
              \`status\` int(11) DEFAULT NULL,
              \`last_login\` int(11) DEFAULT NULL,
              \`recovery_key\` varchar(32) DEFAULT NULL,
              \`changed\` int(11) DEFAULT NULL,
              \`created\` int(11) DEFAULT NULL,
              PRIMARY KEY (\`id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS \`${prefix}team\` (
              \`id\` int(11) NOT NULL AUTO_INCREMENT,
              \`ids\` mediumtext DEFAULT NULL,
              \`owner\` int(11) DEFAULT NULL,
              \`pid\` int(11) DEFAULT NULL,
              \`permissions\` longtext DEFAULT NULL,
              \`data\` longtext DEFAULT NULL,
              PRIMARY KEY (\`id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS \`${prefix}accounts\` (
              \`id\` int(11) unsigned NOT NULL AUTO_INCREMENT,
              \`ids\` varchar(255) DEFAULT NULL,
              \`module\` varchar(255) DEFAULT NULL,
              \`social_network\` varchar(255) DEFAULT NULL,
              \`category\` varchar(255) DEFAULT NULL,
              \`team_id\` int(11) DEFAULT NULL,
              \`login_type\` int(11) DEFAULT NULL,
              \`can_post\` int(1) DEFAULT NULL,
              \`pid\` varchar(255) DEFAULT NULL,
              \`name\` varchar(255) DEFAULT NULL,
              \`username\` varchar(255) DEFAULT NULL,
              \`token\` text DEFAULT NULL,
              \`avatar\` varchar(255) DEFAULT NULL,
              \`url\` varchar(255) DEFAULT NULL,
              \`tmp\` text DEFAULT NULL,
              \`data\` mediumtext DEFAULT NULL,
              \`proxy\` int(11) DEFAULT NULL,
              \`status\` int(11) DEFAULT NULL,
              \`changed\` int(11) DEFAULT NULL,
              \`created\` int(11) DEFAULT NULL,
              \`chatwoot\` mediumtext DEFAULT NULL,
              PRIMARY KEY (\`id\`),
              KEY \`idx_token\` (\`token\`(250)),
              KEY \`idx_team_id\` (\`team_id\`),
              KEY \`idx_token_team\` (\`token\`(191),\`team_id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS \`${prefix}whatsapp_sessions\` (
              \`id\` int(11) NOT NULL AUTO_INCREMENT,
              \`ids\` varchar(32) DEFAULT NULL,
              \`team_id\` int(11) DEFAULT NULL,
              \`instance_id\` varchar(255) DEFAULT NULL,
              \`data\` longtext DEFAULT NULL,
              \`status\` int(11) DEFAULT NULL,
              \`creds\` longtext DEFAULT NULL,
              PRIMARY KEY (\`id\`),
              UNIQUE KEY \`idx_instance_id\` (\`instance_id\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        `);
    } catch (err) {
        console.error("[Database System] Error verifying database tables:", err.message);
        throw err;
    }
}

/**
 * Load WhatsApp session data by instance_id
 */
async function getSession(instanceId) {
    const config = getConfig();
    const prefix = config.prefix || "wb_";
    try {
        const rows = await query(`SELECT * FROM \`${prefix}whatsapp_sessions\` WHERE instance_id = ?`, [instanceId]);
        return rows[0] || null;
    } catch (err) {
        console.error(`[Database System] Failed to load session for instance ${instanceId}:`, err.message);
        return null;
    }
}

/**
 * Save or update WhatsApp session data by instance_id
 */
async function saveSession(instanceId, sessionData) {
    const config = getConfig();
    const prefix = config.prefix || "wb_";
    try {
        const ids = sessionData.ids || Math.random().toString(36).substring(2, 15);
        await query(`
            INSERT INTO \`${prefix}whatsapp_sessions\` (ids, team_id, instance_id, data, status, creds)
            VALUES (?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                data = VALUES(data),
                status = VALUES(status),
                creds = VALUES(creds)
        `, [
            ids,
            sessionData.team_id || 1,
            instanceId,
            sessionData.data,
            sessionData.status !== undefined ? sessionData.status : 1,
            sessionData.creds
        ]);
    } catch (err) {
        console.error(`[Database System] Failed to save session for instance ${instanceId}:`, err.message);
        throw err;
    }
}

/**
 * Save or update WhatsApp account details in wb_accounts
 */
async function saveAccount(instanceId, accountData) {
    const config = getConfig();
    const prefix = config.prefix || "wb_";
    try {
        const { pid, name, username, avatar, profileData } = accountData;
        const now = Math.floor(Date.now() / 1000);
        
        // Check if account with same pid exists
        const existing = await query(`SELECT id, ids, created FROM \`${prefix}accounts\` WHERE pid = ?`, [pid]);
        
        if (existing.length > 0) {
            // Update
            await query(`
                UPDATE \`${prefix}accounts\`
                SET name = ?, username = ?, token = ?, avatar = ?, tmp = ?, status = 1, changed = ?
                WHERE pid = ?
            `, [name, username, instanceId, avatar, profileData, now, pid]);
        } else {
            // Insert new
            const recordIds = Math.random().toString(36).substring(2, 15);
            await query(`
                INSERT INTO \`${prefix}accounts\`
                (ids, module, social_network, category, team_id, login_type, can_post, pid, name, username, token, avatar, url, tmp, status, changed, created)
                VALUES (?, 'whatsapp_profiles', 'whatsapp', 'profile', 1, 2, 0, ?, ?, ?, ?, ?, 'https://web.whatsapp.com/', ?, 1, ?, ?)
            `, [
                recordIds,
                pid,
                name,
                username,
                instanceId,
                avatar || null,
                profileData,
                now,
                now
            ]);
        }
    } catch (err) {
        console.error(`[Database System] Failed to save account for instance ${instanceId}:`, err.message);
        throw err;
    }
}

module.exports = {
    getPool,
    query,
    initialize,
    getSession,
    saveSession,
    saveAccount
};
