const mysql = require("mysql");

const logger = require('../../logger')
const config = require('../../../config')
const { TimeTracker } = require('../../time')

const Database = require("../database");
const sqlite = require("sqlite3");


/**
 * MySQLProvider.
 *
 * @class MySQLProvider
 * @extends {Database}
 *
 */
class MySQLProvider extends Database {
    initDB(callback) {
        let settings = config["mysql-settings"]
        this._sql = mysql.createConnection({
            host: settings.host,
            user: settings.user,
            password: settings.password,
            database: settings.db,
            port: settings.port,
        });

        this._sql.connect((err) => {
            if (err) {
                logger.error("Cannot connect to MySQL database");
                throw err;
            }
            logger.info("Connected to MySQL database");
            callback()
        });
    }

    ensureIndexes(callback) {
        const handleError = (err) => {
            if (err) {
                logger.log("error", "Cannot create table or table index");
                throw err;
            }
        };

        this._sql.query(
            "CREATE TABLE IF NOT EXISTS pings (timestamp BIGINT NOT NULL, ip TINYTEXT, playerCount MEDIUMINT)",
            [],
            handleError
        );
        this._sql.query(
            "CREATE TABLE IF NOT EXISTS players_record (timestamp BIGINT, ip VARCHAR(255), playerCount MEDIUMINT, PRIMARY KEY (ip(255)))",
            [],
            handleError
        );

        this._sql.query(
            "CREATE INDEX ip_index ON pings (ip_hash, playerCount)",
            [],
            (err) => {}
        );

        this._sql.query(
            "CREATE INDEX timestamp_index ON pings (timestamp)",
            [],
            (err) => {
                callback();
            }
        );
    }
    loadRecords(callback) {
        let completedTasks = 0

        this._app.serverRegistrations.forEach((serverRegistration) => {
            serverRegistration.findNewGraphPeak();

            this.getRecord(
                serverRegistration.data.ip,
                (hasRecord, playerCount, timestamp) => {
                    if (hasRecord) {
                        serverRegistration.recordData = {
                            playerCount,
                            timestamp: TimeTracker.toSeconds(timestamp),
                        };
                    } else {
                        this.getRecordLegacy(
                            serverRegistration.data.ip,
                            (hasRecordLegacy, playerCountLegacy, timestampLegacy) => {
                                let newTimestamp = null;
                                let newPlayerCount = null;

                                if (hasRecordLegacy) {
                                    newTimestamp = timestampLegacy;
                                    newPlayerCount = playerCountLegacy;
                                }

                                serverRegistration.recordData = {
                                    playerCount: newPlayerCount,
                                    timestamp: TimeTracker.toSeconds(newTimestamp),
                                };

                                const insertQuery =
                                    "INSERT IGNORE INTO players_record (timestamp, ip, playerCount) VALUES (?, ?, ?)";
                                const values = [
                                    newTimestamp,
                                    serverRegistration.data.ip,
                                    newPlayerCount,
                                ];

                                this._sql.query(insertQuery, values, (err) => {
                                    if (err && err.code !== "ER_DUP_ENTRY") {
                                        logger.error(`Cannot insert initial player count record of ${serverRegistration.data.ip}`)
                                        throw err;
                                    }
                                });
                            }
                        );
                    }

                    // Check if completedTasks hit the finish value
                    // Fire callback since #readyDatabase is complete
                    if (++completedTasks === this._app.serverRegistrations.length) {
                        callback()
                    }
                });

        });
    }

    getRecentPings(startTime, endTime, callback) {
        this._sql.query(
            "SELECT * FROM pings WHERE timestamp >= ? AND timestamp <= ?",
            [startTime, endTime],
            (err, data) => {
                if (err) {
                    logger.log("error", "Cannot get recent pings");
                    throw err;
                }
                callback(data);
            }
        );
    }

    getRecord(ip, callback) {
        this._sql.query(
            "SELECT playerCount, timestamp FROM players_record WHERE ip = ?",
            [ip],
            (err, data) => {
                if (err) {
                    logger.log("error", `Cannot get ping record for ${ip}`);
                    throw err;
                }

                // Record not found
                if (data[0] === undefined) {
                    callback(false);
                    return;
                }

                const playerCount = data[0].playerCount;
                const timestamp = data[0].timestamp;

                callback(true, playerCount, timestamp);
            }
        );
    }

    getRecordLegacy(ip, callback) {
        this._sql.query(
            "SELECT MAX(playerCount) as maxPlayerCount, timestamp FROM pings WHERE ip = ? GROUP BY timestamp",
            [
                ip,
            ],
            (err, data) => {
                if (err) {
                    logger.log("error", `Cannot get legacy ping record for ${ip}`);
                    throw err;
                }

                // For empty results, data will be an empty array []
                if (data.length > 0) {
                    const playerCount = data[0].maxPlayerCount;
                    const timestamp = data[0].timestamp;

                    // eslint-disable-next-line node/no-callback-literal
                    callback(true, playerCount, timestamp);
                } else {
                    // eslint-disable-next-line node/no-callback-literal
                    callback(false);
                }
            }
        );
    }

    insertPing(ip, timestamp, unsafePlayerCount) {
        this._insertPingTo(ip, timestamp, unsafePlayerCount, this._sql);
    }

    _insertPingTo(ip, timestamp, unsafePlayerCount, db) {
        const sqlQuery =
            "INSERT INTO pings (timestamp, ip, playerCount) VALUES (?, ?, ?)";
        const values = [timestamp, ip, unsafePlayerCount];

        db.query(sqlQuery, values, (err) => {
            if (err) {
                logger.error(`Cannot insert ping record of ${ip} at ${timestamp}`);
                throw err;
            }
        });
    }

    updatePlayerCountRecord(ip, playerCount, timestamp) {
        const sqlQuery =
            "UPDATE players_record SET timestamp = ?, playerCount = ? WHERE ip = ?";
        const values = [timestamp, playerCount, ip];

        this._sql.query(sqlQuery, values, (err) => {
            if (err) {
                logger.error(
                    `Cannot update player count record of ${ip} at ${timestamp}`
                );
                throw err;
            }
        });
    }

    initOldPingsDelete(callback) {
        // Delete old pings on startup
        logger.info("Deleting old pings..");
        this.deleteOldPings(() => {
            const oldPingsCleanupInterval =
                config.oldPingsCleanup.interval || 3600000;
            if (oldPingsCleanupInterval > 0) {
                // Delete old pings periodically
                setInterval(() => this.deleteOldPings(), oldPingsCleanupInterval);
            }

            callback();
        });
    }

    deleteOldPings(callback) {
        const oldestTimestamp = TimeTracker.getEpochMillis() - config.graphDuration;

        const deleteStart = TimeTracker.getEpochMillis();
        let sql = 'DELETE FROM pings WHERE timestamp < ?';
        this._sql.query(sql, [oldestTimestamp], function (err, result) {
            if (err) {
                logger.error("Cannot delete old pings");
                throw err;
            } else {
                const deleteTook = TimeTracker.getEpochMillis() - deleteStart;
                logger.info(`Old pings deleted in ${deleteTook}ms`);
                if (callback) {
                    callback();
                }
            }
        });
    }

    // Close the MySQL connection when no longer needed
    close() {
        this._sql.end();
    }
}

module.exports = MySQLProvider