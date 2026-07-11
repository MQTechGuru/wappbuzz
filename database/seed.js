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

        // 1. Seed wb_users
        const usersCountRes = await executeQuery(`SELECT COUNT(*) as count FROM \`${prefix}users\``);
        const usersCount = usersCountRes[0].count;
        if (usersCount === 0) {
            const adminUser = [
                1, "69a1f2379b848", "110455462423388336764", 1, 0, "AdminWAZ", "AdminWAZ",
                "info@mail.mqtechguru.com", "917357935653", "e10adc3949ba59abbe56e057f20f883e",
                4, 2080405800, "Asia/Kolkata", null, "google", "avatar/692fbc080d5d6.jpg",
                '{"is_subscription":0,"bill_owner":"","bill_tax_number":"","bill_address":""}',
                2, 1782991066, null, 1764736596, 1764736008
            ];
            await executeQuery(`
                INSERT INTO \`${prefix}users\` 
                (id, ids, pid, is_admin, role, fullname, username, email, whatsapp, password, plan, expiration_date, timezone, language, login_type, avatar, data, status, last_login, recovery_key, changed, created)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, adminUser);
            statusLogs.push(`✓ ${prefix}users seeded`);
        } else {
            statusLogs.push(`✓ ${prefix}users already exists`);
        }

        // 2. Seed wb_team
        const teamCountRes = await executeQuery(`SELECT COUNT(*) as count FROM \`${prefix}team\``);
        const teamCount = teamCountRes[0].count;
        if (teamCount === 0) {
            const defaultTeam = [
                1, "69a1f2379b848", 1, 4,
                '{"dashboard":"1","whatsapp":"1","whatsapp_profile":"1","whatsapp_bulk":"1","whatsapp_autoresponder":"1","whatsapp_callresponder":"1","whatsapp_history":"1","whatsapp_chatbot":"1","whatsapp_export_participants":"1","whatsapp_contact":"1","whatsapp_evo_profile":"1","whatsapp_api":"1","whatsapp_send_message":"1","whatsapp_list_message_template":"1","whatsapp_poll_template":"1","whatsapp_send_media":"1","whatsapp_autoresponser_delay":"1","whatsapp_chatbot_item_limit":"101","whatsapp_bulk_schedule_by_times":"1","whatsapp_bulk_max_run":"9999999","whatsapp_bulk_max_contact_group":"10000","whatsapp_bulk_max_phone_numbers":"4899998","whatsapp_message_per_month":"1000000","whatsapp_link_generator":"1","whatsapp_data_capturer":"1","whatsapp_api_data":"1","whatsapp_livechat":"1","blog_internal":"1","account_manager":"1","whatsapp_profiles":"1","file_manager":"1","file_manager_photo":"1","file_manager_video":"1","file_manager_other_type":"1","file_manager_image_editor":"1","max_storage_size":"100","max_file_size":"10","tools":"1","group_manager":"1","caption":"1","shortlink":"1","openai":"1","openai_content":"1","openai_image":"1","openai_limit_tokens":"50000","plan_type":2,"number_accounts":"10"}',
                '{"shortlink_status":0}'
            ];
            await executeQuery(`
                INSERT INTO \`${prefix}team\` (id, ids, owner, pid, permissions, data)
                VALUES (?, ?, ?, ?, ?, ?)
            `, defaultTeam);
            statusLogs.push(`✓ ${prefix}team seeded`);
        } else {
            statusLogs.push(`✓ ${prefix}team already exists`);
        }

        // 3. Seed wb_accounts
        const accountsCountRes = await executeQuery(`SELECT COUNT(*) as count FROM \`${prefix}accounts\``);
        const accountsCount = accountsCountRes[0].count;
        if (accountsCount === 0) {
            const acc1 = [
                3, "aggjtb3koobih", "whatsapp_profiles", "whatsapp", "profile", 1, 2, 0,
                "918905446619@s.whatsapp.net", "MU$}{T@Q", "918905446619", "6A4688BEBDBB1",
                "avatar/6a4688f7ddf27.jpg", "https://web.whatsapp.com/",
                '{"id":"918905446619:11@s.whatsapp.net","name":"918905446619@s.whatsapp.net","avatar":"https://pps.whatsapp.net/v/t61.24694-24/620524932_26176471541946732_3730905028153333986_n.jpg?stp=dst-jpg_s96x96_tt6&ccb=11-4&oh=01_Q5Aa4wH-O5xMifky6b510hCupAcWHaWD6pDxOCKIBmka3-dINg&oe=6A53ADDE&_nc_sid=5e03e0&_nc_cat=110"}',
                null, null, 0, 1783019156, 1783007479, null
            ];
            const acc2 = [
                6, "sxmutuftdbl9x", "whatsapp_profiles", "whatsapp", "profile", 1, 2, 0,
                "917357935653@s.whatsapp.net", "MQ Tech Guru YT", "917357935653", "6A4694BD6059A",
                "avatar/6a4694d4cb35e.jpg", "https://web.whatsapp.com/",
                '{"id":"917357935653:29@s.whatsapp.net","name":"MQ Tech Guru YT","avatar":"https://pps.whatsapp.net/v/t61.24694-24/316996832_819735552419156_1972143147487910185_n.jpg?stp=dst-jpg_s96x96_tt6&ccb=11-4&oh=01_Q5Aa4wGQrj7W4TMqIaZ_QiOWdhZT30m-upOWUkiVQjO2xRIs4g&oe=6A53A6E4&_nc_sid=5e03e0&_nc_cat=108"}',
                null, null, 1, 1783027667, 1783010515, null
            ];

            const insertAccountSql = `
                INSERT INTO \`${prefix}accounts\` 
                (id, ids, module, social_network, category, team_id, login_type, can_post, pid, name, username, token, avatar, url, tmp, data, proxy, status, changed, created, chatwoot)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            await executeQuery(insertAccountSql, acc1);
            await executeQuery(insertAccountSql, acc2);
            statusLogs.push(`✓ ${prefix}accounts seeded`);
        } else {
            statusLogs.push(`✓ ${prefix}accounts already exists`);
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
