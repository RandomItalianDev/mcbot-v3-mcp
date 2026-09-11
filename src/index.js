'use strict'

const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const readline = require('readline')
const cfg = require('./config')
const ActionManager = require('./actionManager')
const CommandHandler = require('./commandHandler')
const { startMcpServer } = require('./mcpServer')

let bot = null
let actionManager = null
let commandHandler = null
let autoLoopTimer = null
let isShuttingDown = false

const log = (level, ...args) => {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  console.log(`[${ts}] [${level.toUpperCase()}]`, ...args)
}

function say (message) {
  if (!bot || !message) return
  const clean = String(message).replace(/\n/g, ' ').slice(0, 120)
  log('chat_out', clean)
  try {
    bot.chat(clean)
  } catch (_) {}
}

startMcpServer(() => actionManager, 3001)

function initBot () {
  log('info', `Connecting to ${cfg.host}:${cfg.port} as ${cfg.username}...`)

  const opts = {
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    auth: cfg.auth,
    checkTimeoutInterval: 60000
  }
  if (cfg.version) opts.version = cfg.version

  bot = mineflayer.createBot(opts)
  bot.loadPlugin(pathfinder)

  actionManager = new ActionManager(bot, cfg)
  commandHandler = new CommandHandler(actionManager, cfg, say)

  bot.once('spawn', () => {
    log('info', `Spawned in world. Version: ${bot.version}.`)

    try {
      const moves = new Movements(bot)
      moves.canDig = false // Conservative: never tunnel through structures unless commanded
      moves.allow1by1towers = true
      moves.allowFreeMotion = true
      moves.scaffoldingBlocks = [pink_wool]
      moves.digCost = 3
      moves.placeCost = 2
      moves.entitiesToAvoid = new Set([
			'blaze', 'bogged', 'breeze', 'creaking', 'creeper', 'drowned',
			'elder_guardian', 'ender_dragon', 'endermite', 'evoker', 'ghast',
			'guardian', 'hoglin', 'husk', 'magma_cube', 'phantom', 'piglin_brute',
			'pillager', 'ravager', 'shulker', 'silverfish', 'skeleton', 'slime',
			'spider', 'stray', 'vex', 'vindicator', 'warden', 'witch', 'wither',
			'wither_skeleton', 'zoglin', 'zombie', 'zombie_villager', 'zombified_piglin'
		])
      bot.pathfinder.setMovements(moves)
    } catch (err) {
      log('warn', `Pathfinder config error: ${err.message}`)
    }

    startAutoLoops()
  })

  /* ---------------- Chat Routing ---------------- */

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    if (cfg.debugChat) log('chat', `<${username}> ${message}`)
    if (message.startsWith(cfg.prefix)) {
      commandHandler.handle(username, message.slice(cfg.prefix.length))
    }
  })

  bot.on('whisper', (username, message) => {
    if (username === bot.username) return
    log('whisper', `<${username}> ${message}`)
    const content = message.startsWith(cfg.prefix) ? message.slice(cfg.prefix.length) : message
    commandHandler.handle(username, content)
  })

  /* ---------------- Safety & Health Events ---------------- */

  bot.on('health', () => {
    if (bot.food <= cfg.minHunger && cfg.autoEat && !actionManager.isBusy()) {
      actionManager.eat().catch(() => {})
    }
  })

  bot.on('death', () => {
    log('warn', 'Bot died. Resetting action manager.')
    actionManager.stop()
  })

  bot.on('wake', () => {
    log('info', 'Bot woke up.')
    if (actionManager.getCurrentAction() === 'sleeping') {
      actionManager.stop()
    }
  })

  /* ---------------- Disconnect & Error Handling ---------------- */

  bot.on('kicked', reason => log('warn', `Kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`))
  bot.on('error', err => log('error', `Connection error: ${err.message}`))

  bot.on('end', (reason) => {
    stopAutoLoops()
    actionManager.stop()
    log('warn', `Session ended (${reason}).`)
    if (!isShuttingDown) {
      log('info', `Reconnecting in ${cfg.reconnectDelay / 1000}s...`)
      setTimeout(initBot, cfg.reconnectDelay)
    }
  })
}

/* ---------------- Autonomous Tick Loops ---------------- */

function startAutoLoops () {
  stopAutoLoops()
  autoLoopTimer = setInterval(() => {
    if (!bot || !bot.entity || actionManager.isBusy()) return

    // Auto-Sleep check
    if (cfg.autoSleep && !bot.isSleeping) {
      const timeOfDay = bot.time?.timeOfDay
      const isNight = timeOfDay >= 12542 && timeOfDay <= 23458
      const isOverworld = String(bot.game?.dimension || '').includes('overworld')

      if (isNight && isOverworld) {
        actionManager.sleep().catch(() => {})
      }
    }
  }, 10000)
}

function stopAutoLoops () {
  if (autoLoopTimer) {
    clearInterval(autoLoopTimer)
    autoLoopTimer = null
  }
}

/* ---------------- CLI / Stdin Interface ---------------- */

if (process.stdin.isTTY) {
  const rl = readline.createInterface({ input: process.stdin })
  rl.on('line', (line) => {
    const text = line.trim()
    if (!text || !commandHandler) return
    commandHandler.handle('CONSOLE', text.startsWith(cfg.prefix) ? text.slice(cfg.prefix.length) : text)
  })
}

/* ---------------- Clean Process Shutdown ---------------- */

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    isShuttingDown = true
    log('info', 'Termination requested. Closing...')
    stopAutoLoops()
    if (actionManager) actionManager.stop()
    if (bot) bot.quit('shutdown')
    setTimeout(() => process.exit(0), 500)
  })
}

process.on('unhandledRejection', err => log('error', `Unhandled rejection: ${err?.message || err}`))

initBot()
