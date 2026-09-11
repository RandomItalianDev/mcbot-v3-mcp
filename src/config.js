'use strict'
require('dotenv').config()

module.exports = {
  host: process.env.MC_HOST || '127.0.0.1',
  port: parseInt(process.env.MC_PORT || '25565', 10),
  version: (process.env.MC_VERSION || 'auto').toLowerCase() === 'auto' ? false : process.env.MC_VERSION,
  username: process.env.BOT_USERNAME || 'AgentBot',
  auth: (process.env.MC_AUTH || 'offline').toLowerCase(),

  prefix: process.env.CMD_PREFIX || '!',
  admins: (process.env.ADMINS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
  debugChat: process.env.DEBUG_CHAT === 'true',
  logLevel: process.env.LOG_LEVEL || 'info',

  autoEat: process.env.AUTO_EAT !== 'false',
  autoSleep: process.env.AUTO_SLEEP === 'true',
  minHunger: parseInt(process.env.MIN_HUNGER || '14', 10),
  bedRange: parseInt(process.env.BED_RANGE || '32', 10),

  movementTimeout: parseInt(process.env.MOVEMENT_TIMEOUT || '30', 10) * 1000,
  followDistance: parseInt(process.env.FOLLOW_DISTANCE || '2', 10),
  reconnectDelay: parseInt(process.env.RECONNECT_DELAY || '10', 10) * 1000,
  commandCooldown: parseInt(process.env.COMMAND_COOLDOWN || '500', 10)
}
