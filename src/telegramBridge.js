'use strict'

const API_BASE = 'https://api.telegram.org'
const MAX_MESSAGE_LEN = 3800 // < 4096, margine per lo split

class TelegramBridge {
  constructor (cfg, { onCommand } = {}) {
    const tg = cfg.telegram || {}
    this.token = tg.token || ''
    this.enabled = tg.enabled !== false && Boolean(this.token)
    this.prefix = cfg.prefix || '!'
    this.mirrorLevels = new Set(tg.mirrorLevels || [])
    this.mirrorAll = tg.mirrorAll !== false
    this.allowedChatIds = new Set((tg.allowedChatIds || []).map(String))
    this.allowedUsernames = new Set(tg.allowedUsernames || [])
    this.sendIntervalMs = tg.sendIntervalMs ?? 1100
    this.pollTimeoutSec = tg.pollTimeoutSec ?? 30
    this.maxMirrorLength = tg.maxMirrorLength ?? 600
    this.onCommand = onCommand

    this._offset = 0
    this._running = false
    this._queue = []
    this._draining = false
    this._lastSendAt = new Map()
    this._replyChatId = null
    this._suppress = false
    this._consolePatched = false
    this._warnedOpenAccess = false
  }

  start () {
    if (!this.enabled || this._running) return
    this._running = true
    this._pollLoop()
    this._log('Bridge attivo.')
  }

  async stop () {
    this._running = false
    // un nuovo getUpdates annulla il long polling in corso
    try { await this._api('getUpdates', { offset: this._offset, timeout: 0 }, 5000) } catch (_) {}
  }

  /* ---------------- Output ---------------- */

  /** Mirror di un log applicativo. Chiamato da index.js per ogni livello. */
  mirror (level, args) {
    if (!this.enabled || this._suppress) return
    const lvl = String(level).toLowerCase()
    if (!this.mirrorLevels.has(lvl)) return
    const text = this._format(lvl, args)
    if (!text) return

    if (this._replyChatId) { this._enqueue(this._replyChatId, text); return } // risposta alla chat che ha inviato il comando
    if (!this.mirrorAll) return
    for (const chatId of this.allowedChatIds) this._enqueue(chatId, text)
  }

  /** Invia testo alla chat del comando in corso, o broadcast se fuori contesto. */
  reply (text) {
    const target = this._replyChatId || [...this.allowedChatIds][0]
    if (target) this._enqueue(target, String(text))
  }

  send (text, chatId) {
    if (chatId !== undefined && chatId !== null) this._enqueue(String(chatId), String(text))
    else this.reply(text)
  }

  /** Cattura anche le console.log/error dirette (es. actionManager.js). */
  attachConsoleMirror () {
    if (this._consolePatched || !this.enabled) return
    this._consolePatched = true
    const map = { log: 'console', info: 'console', warn: 'warn', error: 'error' }
    for (const [method, level] of Object.entries(map)) {
      const original = console[method].bind(console)
      console[method] = (...args) => {
        original(...args)
        if (this._suppress) return
        const prev = this._suppress
        this._suppress = true
        try { this.mirror(level, args) } finally { this._suppress = prev }
      }
    }
  }

  /* ---------------- Input (long polling) ---------------- */

  async _pollLoop () {
    while (this._running) {
      try {
        const updates = await this._api('getUpdates', {
          offset: this._offset,
          timeout: this.pollTimeoutSec,
          allowed_updates: ['message']
        }, (this.pollTimeoutSec + 15) * 1000)

        for (const u of updates) {
          this._offset = u.update_id + 1
          await this._handleUpdate(u) // sequenziale: mantiene valido _replyChatId
        }
      } catch (err) {
        if (!this._running) return
        this._log(`Polling fallito: ${err.message}. Retry in 2s.`)
        await new Promise(r => setTimeout(r, 2000))
      }
    }
  }

  async _handleUpdate (update) {
    const msg = update.message
    if (!msg || !msg.text) return

    const chatId = String(msg.chat.id)
    const username = (msg.from?.username || '').toLowerCase()

    if (!this._isAuthorized(chatId, username)) {
      this._log(`Accesso negato a chat ${chatId} (@${username || 'n/d'}). Aggiungi l'id a TELEGRAM_ALLOWED_CHAT_IDS.`)
      return
    }

    const text = this._normalize(msg.text)
    if (!text) return

    if (text.toLowerCase() === 'ping') { this.send('pong', chatId); return }

    if (!this.onCommand) { this.send('Bridge non collegato al bot Minecraft.', chatId); return }

    this._replyChatId = chatId
    try {
      await this.onCommand(`TG:${username || chatId}`, text)
    } catch (err) {
      this.send(`Errore: ${err.message}`, chatId)
    } finally {
      this._replyChatId = null
    }
  }

  _normalize (raw) {
    let text = String(raw).trim()
    if (text.startsWith('/')) {
      text = text.slice(1)
      const at = text.indexOf('@') // /status@MyBot
      const sp = text.indexOf(' ')
      if (at !== -1 && (sp === -1 || at < sp)) text = text.slice(0, at) + (sp === -1 ? '' : text.slice(sp))
    }
    if (text.startsWith(this.prefix)) text = text.slice(this.prefix.length)
    return text.trim()
  }

  _isAuthorized (chatId, username) {
    if (!this.allowedChatIds.size && !this.allowedUsernames.size) {
      if (!this._warnedOpenAccess) {
        this._warnedOpenAccess = true
        this._log('ATTENZIONE: nessuna allowlist configurata, il bot accetta comandi da chiunque.')
      }
      return true
    }
    return this.allowedChatIds.has(chatId) || this.allowedUsernames.has(username)
  }

  /* ---------------- Trasporto / coda ---------------- */

  async _api (method, payload, timeoutMs = 15000) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      })
      const data = await res.json().catch(() => ({}))
      if (!data.ok) throw new Error(data.description || `HTTP ${res.status}`)
      return data.result
    } finally {
      clearTimeout(timer)
    }
  }

  _enqueue (chatId, text) {
    this._queue.push({ chatId, text })
    this._drain()
  }

  async _drain () {
    if (this._draining) return
    this._draining = true
    try {
      while (this._queue.length) {
        const { chatId, text } = this._queue.shift()
        const wait = this.sendIntervalMs - (Date.now() - (this._lastSendAt.get(chatId) || 0))
        if (wait > 0) await new Promise(r => setTimeout(r, wait))
        this._lastSendAt.set(chatId, Date.now())
        try {
          for (const chunk of this._chunk(text)) {
            await this._api('sendMessage', { chat_id: chatId, text: chunk, disable_web_page_preview: true })
          }
        } catch (err) {
          this._log(`Invio fallito (chat ${chatId}): ${err.message}`)
        }
      }
    } finally {
      this._draining = false
    }
  }

  _chunk (text) {
    const out = []
    let s = String(text)
    while (s.length > MAX_MESSAGE_LEN) {
      let cut = s.lastIndexOf('\n', MAX_MESSAGE_LEN)
      if (cut <= 0) cut = MAX_MESSAGE_LEN
      out.push(s.slice(0, cut))
      s = s.slice(cut)
    }
    if (s.length) out.push(s)
    return out
  }

  _format (level, args) {
    const body = args.map(a => {
      if (a instanceof Error) return a.message
      if (a === null || a === undefined) return String(a)
      if (typeof a === 'string') return a
      if (typeof a === 'object') { try { return JSON.stringify(a) } catch { return String(a) } }
      return String(a)
    }).join(' ')
    const text = `[${level}] ${body}`.trim()
    return text.length > this.maxMirrorLength ? `${text.slice(0, this.maxMirrorLength)}…` : text
  }

  _log (message) {
    const prev = this._suppress
    this._suppress = true
    try { console.log(`[Telegram] ${message}`) } finally { this._suppress = prev }
  }
}

module.exports = TelegramBridge