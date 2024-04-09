const pingJava = (...args) => import('@minescope/mineping').then(module => module.pingJava(...args));
const pingBedrock = (...args) => import('@minescope/mineping').then(module => module.pingBedrock(...args));

const logger = require('./logger')
const MessageOf = require('./message')
const { TimeTracker } = require('./time')

const { getPlayerCountOrNull } = require('./util')

const config = require('../config')

function pingServ (serverRegistration, timeout) {
  return new Promise(async (resolve, reject) => {
    switch (serverRegistration.data.type) {
      case 'PC':
        try {
          const data = await pingJava(serverRegistration.data.ip, {
            port: serverRegistration.data.port || 25565,
            timeout: timeout
          });

          let playersOnline = data.players.online
          const payload = {
            players: {
              online: capPlayerCount(serverRegistration.data.ip, playersOnline)
            },
            version: data.version.protocol
          }

          // Ensure the returned favicon is a data URI
          if (data.favicon && data.favicon.startsWith('data:image/')) {
            payload.favicon = data.favicon
          }

          return resolve(payload)
        } catch (e) {
          return reject(e)
        }
        break

      case 'PE':
        try {
          const data = await pingBedrock(serverRegistration.data.ip, {
            port: serverRegistration.data.port || 19132,
            timeout: timeout
          });

          let playersOnline = data.players.online;
          return resolve({
            players: {
              online: capPlayerCount(serverRegistration.data.ip, playersOnline)
            }
          })
        } catch (e) {
          return reject(e)
        }
        break

      default:
        reject(new Error('Unsupported type: ' + serverRegistration.data.type))
    }
  })
}

// player count can be up to 1^32-1, which is a massive scale and destroys browser performance when rendering graphs
// Artificially cap and warn to prevent propogating garbage
function capPlayerCount (host, playerCount) {
  const maxPlayerCount = 250000

  if (playerCount !== Math.min(playerCount, maxPlayerCount)) {
    logger.log('warn', '%s returned a player count of %d, Minetrack has capped it to %d to prevent browser performance issues with graph rendering. If this is in error, please edit maxPlayerCount in ping.js!', host, playerCount, maxPlayerCount)
    return 0
  } else if (playerCount !== Math.max(playerCount, 0)) {
    logger.log('warn', '%s returned an invalid player count of %d, setting to 0.', host, playerCount)
    return 0
  }
  return playerCount
}

class PingController {
  constructor (app) {
    this._app = app
    this._isRunningTasks = false
  }

  async schedule () {
    await this.pingAll()
  }

  async pingAll () {
    const { timestamp, updateHistoryGraph } = this._app.timeTracker.newPointTimestamp()

    try {
      const results = await this.startPingTasks()
      const updates = []

      for (const serverRegistration of this._app.serverRegistrations) {
        const result = results[serverRegistration.serverId]

        // Log to database if enabled
        // Use null to represent a failed ping
        if (config.logToDatabase) {
          const unsafePlayerCount = getPlayerCountOrNull(result.resp)

          this._app.database.insertPing(serverRegistration.data.ip, timestamp, unsafePlayerCount)
        }

        // Generate a combined update payload
        // This includes any modified fields and flags used by the frontend
        // This will not be cached and can contain live metadata
        const update = serverRegistration.handlePing(timestamp, result.resp, result.err, updateHistoryGraph)

        updates[serverRegistration.serverId] = update
      }

      // Send object since updates uses serverIds as keys
      // Send a single timestamp entry since it is shared
      this._app.server.broadcast(MessageOf('updateServers', {
        timestamp: TimeTracker.toSeconds(timestamp),
        updateHistoryGraph,
        updates
      }))
    } catch (err) {
      logger.log('warn', err.message)
    }
  }

  startPingTasks = async () => {
    if (this._isRunningTasks) {
      throw new Error('Started re-pinging servers before the last loop has finished! You may need to increase "rates.pingAll" in config.json')
    }

    this._isRunningTasks = true

    const results = []
    for (const serverRegistration of this._app.serverRegistrations) {
      let err = null
      let resp = null
      try {
        resp = await pingServ(serverRegistration, config.rates.connectTimeout)
      } catch (e) {
        err = e
        if (config.logFailedPings !== false) {
          logger.log('error', 'Failed to ping %s: %s', serverRegistration.data.ip, err.message)
        }
      }

      results[serverRegistration.serverId] = {
        resp,
        err
      }
    }
    // Loop has completed, release the locking flag
    this._isRunningTasks = false
    return results
  }
}

module.exports = PingController
