// constants.js
'use strict'

const HOSTILE_MOBS = [
  'blaze', 'bogged', 'breeze', 'creaking', 'creeper', 'drowned',
  'elder_guardian', 'ender_dragon', 'endermite', 'evoker', 'ghast',
  'guardian', 'hoglin', 'husk', 'magma_cube', 'phantom', 'piglin_brute',
  'pillager', 'ravager', 'shulker', 'silverfish', 'skeleton', 'slime',
  'spider', 'stray', 'vex', 'vindicator', 'warden', 'witch', 'wither',
  'wither_skeleton', 'zoglin', 'zombie', 'zombie_villager', 'zombified_piglin'
]

const HOSTILE_SET = new Set(HOSTILE_MOBS)

function normalizeName(name) {
  return String(name).toLowerCase().replace('minecraft:', '').replace(/ /g, '_')
}

module.exports = { HOSTILE_MOBS, HOSTILE_SET, normalizeName }