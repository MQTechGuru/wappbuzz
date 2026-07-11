/**
 * Config.js - Global Application Configuration
 *
 * host        : Server host (e.g. http://localhost).
 * port        : Server port.
 * access_key  : Your WappBuzz API access key (enter manually).
 * instance_id : Auto-populated after a successful Create Instance call.
 */

module.exports = {
    host: "http://localhost",
    port: 3000,
    prefix: "wb_",
    frontend: 'http://localhost/wappbuzzinstall',
    redis: "redis://127.0.0.1:6379",
    database: {
        "connectionLimit": 500,
        "host": "localhost",
        "user": "root",
        "password": "Ramju786@@@",
        "database": "wappbuzz",
        "charset": "utf8mb4",
        "debug": false,
        "waitForConnections": true,
        "multipleStatements": true
    }
};
