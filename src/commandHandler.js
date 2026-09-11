'use strict'

class CommandHandler
{
  constructor(actionManager, cfg, sayCallback)
  {
    this.actions = actionManager
    this.cfg = cfg
    this.say = sayCallback
    this.lastCommandTime = 0
  }

  async handle(sender, rawMessage)
  {
    const now = Date.now()
    if (now - this.lastCommandTime < this.cfg.commandCooldown) return
    this.lastCommandTime = now

    const parts = rawMessage.trim().split(/\s+/)
    const cmd = (parts.shift() || '').toLowerCase()
    const args = parts

    const isAdmin = sender === 'CONSOLE' ||
      this.cfg.admins.length === 0 ||
      this.cfg.admins.includes(sender.toLowerCase())

    try
    {
      switch (cmd)
      {
        case 'stop': {
          const res = this.actions.stop()
          return this.say(res.msg)
        }

        case 'come': {
          const target = args[0] || sender
          if (target === 'CONSOLE') return this.say('Specify player name: !come <player>')
          this.say(`Navigating to ${target}...`)
          const res = await this.actions.come(target)
          return this.say(res.msg)
        }

        case 'follow': {
          const target = args[0] || sender
          if (target === 'CONSOLE') return this.say('Specify player name: !follow <player>')
          const res = await this.actions.follow(target)
          return this.say(res.msg)
        }

        case 'goto': {
          if (args.length < 2) return this.say('Usage: !goto <x> <z> OR !goto <x> <y> <z>')
          let x, y, z
          if (args.length === 2)
          {
            x = parseFloat(args[0])
            z = parseFloat(args[1])
          } else
          {
            x = parseFloat(args[0])
            y = parseFloat(args[1])
            z = parseFloat(args[2])
          }
          if (isNaN(x) || isNaN(z)) return this.say('Invalid coordinates.')
          this.say(`Going to [${x}, ${y || '~'}, ${z}]...`)
          const res = await this.actions.goto(x, y, z)
          return this.say(res.msg)
        }

        case 'eat': {
          const res = await this.actions.eat()
          return this.say(res.msg)
        }

        case 'sleep': {
          const res = await this.actions.sleep()
          return this.say(res.msg)
        }

        case 'wake': {
          const res = await this.actions.wake()
          return this.say(res.msg)
        }

        case 'status': {
          const { data } = this.actions.getStatus()
          return this.say(`P:[${data.pos.join(',')}] D:${data.dim} HP:${data.hp}/20 F:${data.food}/20 A:${data.action}`)
        }

        case 'pos': {
          const { data } = this.actions.getStatus()
          return this.say(`XYZ: ${data.pos.join(' ')} (${data.dim})`)
        }

        case 'inv': {
          const detailed = args[0] === 'details'
          const res = this.actions.getInventory(detailed)
          return this.say(res.msg)
        }

        case 'mine': {
          // if (!isAdmin) return this.say('Admin permission required.')
          if (!args[0]) return this.say('Usage: !mine <block>')
          this.say(`Searching for ${args[0]}...`)
          const res = await this.actions.mine(args[0])
          return this.say(res.msg)
        }

        case 'place': {
          // if (!isAdmin) return this.say('Admin permission required.')
          if (!args[0]) return this.say('Usage: !place <block>')
          const res = await this.actions.placeBlock(args[0])
          return this.say(res.msg)
        }

        case 'equip': {
          if (!args[0]) return this.say('Usage: !equip <item> [hand|head|torso|legs|feet]')
          const res = await this.actions.equip(args[0], args[1] || 'hand')
          return this.say(res.msg)
        }

        case 'near': {
          const res = this.actions.getNearbyEntities()
          if (!res.data.length) return this.say('No entities nearby.')
          const summary = res.data.map(e => `${e.name}(${e.dist}m)`).join(', ')
          return this.say(`Near: ${summary}`)
        }

        case 'help': {
          return this.say('Cmds: !come !follow !goto !stop !eat !sleep !status !pos !inv !mine !place !near')
        }

        default:
          return this.say(`Unknown command. Type ${this.cfg.prefix}help`)
      }
    } catch (err)
    {
      return this.say(`Err: ${err.message}`)
    }
  }
}

module.exports = CommandHandler
