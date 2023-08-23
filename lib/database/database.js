const config = require('../../config')
const logger = require('../logger')
const { TimeTracker } = require('../time')

class Database {
  constructor (app) {
    this._app = app
    if (this.constructor === Database) {
      throw new Error("Abstract classes can't be instantiated.");
    }
  }

  initDB (callback) {}

  ensureIndexes (callback) {}

  loadGraphPoints (graphDuration, callback) {
    // Query recent pings
    const endTime = TimeTracker.getEpochMillis()
    const startTime = endTime - graphDuration

    this.getRecentPings(startTime, endTime, pingData => {
      const relativeGraphData = []

      for (const row of pingData) {
        // Load into temporary array
        // This will be culled prior to being pushed to the serverRegistration
        let graphData = relativeGraphData[row.ip]
        if (!graphData) {
          relativeGraphData[row.ip] = graphData = [[], []]
        }

        // DANGER!
        // This will pull the timestamp from each row into memory
        // This is built under the assumption that each round of pings shares the same timestamp
        // This enables all timestamp arrays to have consistent point selection and graph correctly
        graphData[0].push(row.timestamp)
        graphData[1].push(row.playerCount)
      }

      Object.keys(relativeGraphData).forEach(ip => {
        // Match IPs to serverRegistration object
        for (const serverRegistration of this._app.serverRegistrations) {
          if (serverRegistration.data.ip === ip) {
            const graphData = relativeGraphData[ip]

            // Push the data into the instance and cull if needed
            serverRegistration.loadGraphPoints(startTime, graphData[0], graphData[1])

            break
          }
        }
      })

      // Since all timestamps are shared, use the array from the first ServerRegistration
      // This is very dangerous and can break if data is out of sync
      if (Object.keys(relativeGraphData).length > 0) {
        const serverIp = Object.keys(relativeGraphData)[0]
        const timestamps = relativeGraphData[serverIp][0]

        this._app.timeTracker.loadGraphPoints(startTime, timestamps)
      }

      callback()
    })
  }

  loadRecords (callback) {}

  getRecentPings (startTime, endTime, callback) {}

  getRecord (ip, callback) {}

  // Retrieves record from pings table, used for converting to separate table
  getRecordLegacy (ip, callback) {}

  insertPing (ip, timestamp, unsafePlayerCount) {}

  updatePlayerCountRecord (ip, playerCount, timestamp) {}

  initOldPingsDelete (callback) {
    // Delete old pings on startup
    logger.info('Deleting old pings..')
    this.deleteOldPings(() => {
      const oldPingsCleanupInterval = config.oldPingsCleanup.interval || 3600000
      if (oldPingsCleanupInterval > 0) {
        // Delete old pings periodically
        setInterval(() => this.deleteOldPings(), oldPingsCleanupInterval)
      }

      callback()
    })
  }

  deleteOldPings (callback) {}

}

module.exports = Database
