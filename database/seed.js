const fs = require("fs");
const path = require("path");

// Resolve configuration dynamically to pick up updates
function getConfig() {
    const configPath = path.resolve(__dirname, "..", "Config.js");
    if (require.cache[configPath]) {
        delete require.cache[configPath];
    }
    return require(configPath);
}

/**
 * Runs the database seed logic inside a MySQL transaction using the provided pool.
 * @param {object} pool - Existing MySQL connection pool
 */
async function runDatabaseSeed(pool) {
    if (!pool) {
        throw new Error("No MySQL connection pool provided to runDatabaseSeed");
    }

    const config = getConfig();
    const prefix = config.prefix || "wb_";

    // Obtain a connection from the pool
    const conn = await new Promise((resolve, reject) => {
        pool.getConnection((err, connection) => {
            if (err) reject(err);
            else resolve(connection);
        });
    });

    // Helper to run query on the connection
    const executeQuery = (sql, params = []) => {
        return new Promise((resolve, reject) => {
            conn.query(sql, params, (err, results) => {
                if (err) reject(err);
                else resolve(results);
            });
        });
    };

    try {
        // Begin Transaction
        await new Promise((resolve, reject) => {
            conn.beginTransaction((err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        const statusLogs = [];

        // Truncate runtime tables before seeding
        console.log(`[SEED] Truncating runtime tables...`);
        await executeQuery("SET FOREIGN_KEY_CHECKS = 0");
        await executeQuery(`TRUNCATE TABLE \`${prefix}accounts\``);
        await executeQuery(`TRUNCATE TABLE \`${prefix}whatsapp_sessions\``);
        await executeQuery("SET FOREIGN_KEY_CHECKS = 1");
        statusLogs.push(`✓ Runtime tables ${prefix}accounts and ${prefix}whatsapp_sessions truncated`);

        // 1. Seed wb_users
        const usersCountRes = await executeQuery(`SELECT COUNT(*) as count FROM \`${prefix}users\``);
        const usersCount = usersCountRes[0].count;
        let adminIds = "demo_admin_ids";
        if (usersCount === 0) {
            adminIds = Math.random().toString(36).substring(2, 15);
            const userPid = Math.floor(100000000000 + Math.random() * 900000000000).toString();
            const recoveryKey = Math.random().toString(36).substring(2, 15);
            const now = Math.floor(Date.now() / 1000);

            const adminUser = [
                1, adminIds, userPid, 1, 0, "Admin", "admin",
                "admin@example.com", null, "e10adc3949ba59abbe56e057f20f883e", // md5 of "123456"
                4, 2080405800, "Asia/Kolkata", null, "local", null,
                '{"is_subscription":0,"bill_owner":"","bill_tax_number":"","bill_address":""}',
                1, null, recoveryKey, now, now
            ];
            await executeQuery(`
                INSERT INTO \`${prefix}users\` 
                (id, ids, pid, is_admin, role, fullname, username, email, whatsapp, password, plan, expiration_date, timezone, language, login_type, avatar, data, status, last_login, recovery_key, changed, created)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, adminUser);
            statusLogs.push(`✓ ${prefix}users seeded`);
        } else {
            statusLogs.push(`✓ ${prefix}users already exists`);
            const existingUser = await executeQuery(`SELECT ids FROM \`${prefix}users\` WHERE id = 1`);
            if (existingUser.length > 0) {
                adminIds = existingUser[0].ids;
            }
        }

        // 2. Seed wb_team
        const teamCountRes = await executeQuery(`SELECT COUNT(*) as count FROM \`${prefix}team\``);
        const teamCount = teamCountRes[0].count;
        if (teamCount === 0) {
            const teamIds = adminIds; // Use identical IDs for user and team
            const teamPid = Math.floor(100 + Math.random() * 900);
            const defaultTeam = [
                1, teamIds, 1, teamPid,
                '{"dashboard":"1","whatsapp":"1","whatsapp_profile":"1","whatsapp_bulk":"1","whatsapp_autoresponder":"1","whatsapp_callresponder":"1","whatsapp_history":"1","whatsapp_chatbot":"1","whatsapp_export_participants":"1","whatsapp_contact":"1","whatsapp_evo_profile":"1","whatsapp_api":"1","whatsapp_send_message":"1","whatsapp_list_message_template":"1","whatsapp_poll_template":"1","whatsapp_send_media":"1","whatsapp_autoresponser_delay":"1","whatsapp_chatbot_item_limit":"101","whatsapp_bulk_schedule_by_times":"1","whatsapp_bulk_max_run":"9999999","whatsapp_bulk_max_contact_group":"10000","whatsapp_bulk_max_phone_numbers":"4899998","whatsapp_message_per_month":"1000000","whatsapp_link_generator":"1","whatsapp_data_capturer":"1","whatsapp_api_data":"1","whatsapp_livechat":"1","blog_internal":"1","account_manager":"1","whatsapp_profiles":"1","file_manager":"1","file_manager_photo":"1","file_manager_video":"1","file_manager_other_type":"1","file_manager_image_editor":"1","max_storage_size":"100","max_file_size":"10","tools":"1","group_manager":"1","caption":"1","shortlink":"1","openai":"1","openai_content":"1","openai_image":"1","openai_limit_tokens":"50000","plan_type":2,"number_accounts":"10"}',
                '{"shortlink_status":0}'
            ];
            await executeQuery(`
                INSERT INTO \`${prefix}team\` (id, ids, owner, pid, permissions, data)
                VALUES (?, ?, ?, ?, ?, ?)
            `, defaultTeam);
            statusLogs.push(`✓ ${prefix}team seeded with access_token (ids): ${teamIds}`);
        } else {
            statusLogs.push(`✓ ${prefix}team already exists`);
        }


        // Commit Transaction
        await new Promise((resolve, reject) => {
            conn.commit((err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Print table logs
        statusLogs.forEach(log => console.log(log));

    } catch (err) {
        // Rollback Transaction
        await new Promise((resolve) => {
            conn.rollback(() => {
                resolve();
            });
        });
        console.error("✗ Database Seeding Failed. Rolled back transaction. Error:", err.message);
    } finally {
        conn.release();
    }
}

module.exports = {
    runDatabaseSeed
};
