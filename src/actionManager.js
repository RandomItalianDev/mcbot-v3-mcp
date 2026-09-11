'use strict'

// MODIFICA: Aggiunte librerie native per la gestione dei file
const fs = require('fs').promises
const path = require('path')

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

const EDIBLE_FOODS = new Set([
	'apple', 'baked_potato', 'cooked_beef', 'cooked_chicken', 'cooked_cod',
	'cooked_mutton', 'cooked_porkchop', 'cooked_salmon', 'bread', 'golden_apple',
	'carrot', 'cooked_rabbit', 'mushroom_stew', 'beetroot_soup', 'sweet_berries'
])

class ActionManager
{
	constructor(bot, cfg)
	{
		this.bot = bot
		this.cfg = cfg

		/* ---------------- MODIFICA: Gestione Persistenza Stato ---------------- */
		// Determina il percorso del file di stato. Se cfg.stateFile non è specificato, usa 'state.json' nella cartella di esecuzione.
		// path.resolve garantisce un percorso assoluto, utile per il debugging per sapere esattamente dove viene scritto il file.
		this.stateFilePath = path.resolve(cfg?.stateFile || 'state.json')

		// Inizializza le strutture dati (verranno sovrascritte/popolate dal caricamento)
		this.homes = new Map()
		this.markers = new Map()
		/* ---------------------------------------------------------------------- */

		this.currentAction = { type: 'idle', id: 0, cancel: null }
		this.actionCounter = 0

		this._paused = false
		this._currentTask = null
		this._avoid = new Map()
		this._protectTarget = null

		// MODIFICA: Carica lo stato persistente all'avvio del bot
		this._loadState().catch(err =>
		{
			console.error(`[ActionManager] ERRORE CRITICO nel caricamento dello stato iniziale: ${err.message}`)
			console.error(`[ActionManager] Verifica i permessi di lettura o la sintassi JSON del file: ${this.stateFilePath}`)
		})
	}

	/* ---------------- Gestione Stato Persistente (File Locale) ---------------- */

	/**
	 * Carica lo stato (homes, markers) dal file JSON locale.
	 * Se il file non esiste, lo crea con una struttura vuota (comportamento normale al primo avvio).
	 */
	async _loadState()
	{
		try
		{
			await fs.access(this.stateFilePath)
			const rawData = await fs.readFile(this.stateFilePath, 'utf8')
			const state = JSON.parse(rawData)

			// Ripopola le Mappe dai dati letti. Object.entries converte l'oggetto in array di coppie [chiave, valore]
			this.homes = new Map(Object.entries(state.homes || {}))
			this.markers = new Map(Object.entries(state.markers || {}))

			console.log(`[ActionManager] Stato caricato con successo da: ${this.stateFilePath}`)
		} catch (err)
		{
			if (err.code === 'ENOENT')
			{
				// File non trovato: è normale alla prima esecuzione. Lo inizializziamo vuoto.
				console.log(`[ActionManager] File di stato non trovato. Creazione di un nuovo file: ${this.stateFilePath}`)
				await this._saveState()
			} else
			{
				// Altri errori (es. JSON malformato): rilancia per bloccare l'avvio e forzare il troubleshooting
				throw err
			}
		}
	}

	/**
	 * Salva lo stato corrente (homes, markers) nel file JSON locale.
	 * Converte le Mappe in Oggetti plain per una corretta serializzazione JSON.
	 */
	async _saveState()
	{
		try
		{
			const state = {
				homes: Object.fromEntries(this.homes),
				markers: Object.fromEntries(this.markers),
				lastUpdated: new Date().toISOString() // Utile per il troubleshooting: verifica quando è stato salvato l'ultimo dato
			}
			// MODIFICA: JSON.stringify con indentazione a 2 spazi. 
			// Questo ti permette di aprire state.json con un editor di testo e correggere manualmente le coordinate se necessario.
			await fs.writeFile(this.stateFilePath, JSON.stringify(state, null, 2), 'utf8')
		} catch (err)
		{
			console.error(`[ActionManager] ERRORE nel salvataggio dello stato su disco: ${err.message}`)
			console.error(`[ActionManager] Percorso tentato: ${this.stateFilePath}`)
			// Non lanciamo l'errore (throw) per non interrompere l'azione corrente del bot, 
			// ma il log è fondamentale per il troubleshooting manuale.
		}
	}

	/* ---------------- Concurrency & State Locking ---------------- */

	_startAction(type)
	{
		this.stop()
		const id = ++this.actionCounter
		let cancelled = false
		const cancel = () => { cancelled = true }
		this.currentAction = { type, id, cancel }
		return { id, isCancelled: () => cancelled || this.currentAction.id !== id }
	}

	stop()
	{
		if (this.currentAction.cancel)
		{
			this.currentAction.cancel()
		}
		this.currentAction = { type: 'idle', id: ++this.actionCounter, cancel: null }

		if (this.bot.pathfinder)
		{
			this.bot.pathfinder.stop()
			this.bot.pathfinder.setGoal(null)
		}
		this.bot.clearControlStates()
		return { ok: true, msg: 'Stopped all actions.' }
	}

	isBusy()
	{
		return this.currentAction.type !== 'idle'
	}

	getCurrentAction()
	{
		return this.currentAction.type
	}

	/* ---------------- Navigation ---------------- */

	async goto(x, y, z)
	{
		const action = this._startAction('moving')
		const goal = (y !== null && y !== undefined)
			? new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), 1)
			: new goals.GoalXZ(Math.floor(x), Math.floor(z))

		return new Promise((resolve) =>
		{
			const timeout = setTimeout(() =>
			{
				if (!action.isCancelled()) this.stop()
				resolve({ ok: false, msg: 'Navigation timed out.' })
			}, this.cfg.movementTimeout)

			this.bot.pathfinder.setGoal(goal)

			const cleanup = () =>
			{
				clearTimeout(timeout)
				this.bot.removeListener('goal_reached', onReached)
				this.bot.removeListener('path_reset', onReset)
			}

			const onReached = () =>
			{
				cleanup()
				if (action.isCancelled()) return
				this.currentAction.type = 'idle'
				resolve({ ok: true, msg: `Reached [${Math.floor(x)}, ${y ? Math.floor(y) : '~'}, ${Math.floor(z)}].` })
			}

			const onReset = (reason) =>
			{
				if (reason === 'goal_moved' || action.isCancelled()) return
				cleanup()
				resolve({ ok: false, msg: `Navigation aborted: ${reason}.` })
			}

			this.bot.once('goal_reached', onReached)
			this.bot.on('path_reset', onReset)
		})
	}

	async come(playerName)
	{
		const target = this._resolvePlayerEntity(playerName)
		if (!target) return { ok: false, msg: `Player "${playerName}" not found nearby.` }

		const pos = target.position
		return this.goto(pos.x, pos.y, pos.z)
	}

	async follow(playerName)
	{
		const target = this._resolvePlayerEntity(playerName)
		if (!target) return { ok: false, msg: `Player "${playerName}" not visible.` }

		this._startAction('following')
		this.bot.pathfinder.setGoal(new goals.GoalFollow(target, this.cfg.followDistance), true)
		return { ok: true, msg: `Following ${playerName}.` }
	}

	/* ---------------- Survival & Consumables ---------------- */

	async eat()
	{
		if (this.bot.food >= 20) return { ok: true, msg: 'Hunger full.' }

		const action = this._startAction('eating')
		const foodItem = this.bot.inventory.items().find(i => EDIBLE_FOODS.has(i.name))
		if (!foodItem)
		{
			this.currentAction.type = 'idle'
			return { ok: false, msg: 'No edible food in inventory.' }
		}

		try
		{
			await this.bot.equip(foodItem, 'hand')
			if (action.isCancelled()) return { ok: false, msg: 'Eat action cancelled.' }
			await this.bot.consume()
			this.currentAction.type = 'idle'
			return { ok: true, msg: `Ate ${foodItem.name}. Food: ${Math.round(this.bot.food)}/20.` }
		} catch (err)
		{
			this.currentAction.type = 'idle'
			return { ok: false, msg: `Eat failed: ${err.message}` }
		}
	}

	async sleep()
	{
		if (this.bot.isSleeping) return { ok: true, msg: 'Already sleeping.' }

		const dim = String(this.bot.game?.dimension || '')
		if (dim.includes('nether') || dim.includes('end'))
		{
			return { ok: false, msg: 'Beds explode in this dimension.' }
		}

		const action = this._startAction('sleeping')
		const bedBlock = this.bot.findBlock({
			matching: block => this.bot.isABed(block),
			maxDistance: this.cfg.bedRange
		})

		if (!bedBlock)
		{
			this.currentAction.type = 'idle'
			return { ok: false, msg: `No bed within ${this.cfg.bedRange}m.` }
		}

		try
		{
			await this.bot.pathfinder.goto(new goals.GoalNear(bedBlock.position.x, bedBlock.position.y, bedBlock.position.z, 2))
			if (action.isCancelled()) return { ok: false, msg: 'Sleep cancelled during travel.' }

			const currentBed = this.bot.blockAt(bedBlock.position)
			if (!currentBed || !this.bot.isABed(currentBed))
			{
				this.currentAction.type = 'idle'
				return { ok: false, msg: 'Bed was moved or destroyed.' }
			}

			await this.bot.sleep(currentBed)
			return { ok: true, msg: 'Sleeping.' }
		} catch (err)
		{
			this.currentAction.type = 'idle'
			return { ok: false, msg: `Sleep failed: ${this._parseSleepError(err.message)}` }
		}
	}

	async wake()
	{
		if (!this.bot.isSleeping) return { ok: false, msg: 'Not sleeping.' }
		try
		{
			await this.bot.wake()
			this.currentAction.type = 'idle'
			return { ok: true, msg: 'Woke up.' }
		} catch (err)
		{
			return { ok: false, msg: `Wake failed: ${err.message}` }
		}
	}

	/* ---------------- Interaction & Mining ---------------- */

	async mine(blockName)
	{
		const action = this._startAction('mining')
		const targetBlock = this.bot.findBlock({
			matching: b => b.name.toLowerCase().includes(blockName.toLowerCase()),
			maxDistance: 16
		})

		if (!targetBlock)
		{
			this.currentAction.type = 'idle'
			return { ok: false, msg: `No ${blockName} block found within 16m.` }
		}

		try
		{
			await this.bot.pathfinder.goto(new goals.GoalLookAtBlock(targetBlock.position, this.bot.world))
			if (action.isCancelled()) return { ok: false, msg: 'Mining cancelled.' }

			const tool = this.bot.pathfinder.getBestHarvestTool(targetBlock)
			if (tool) await this.bot.equip(tool, 'hand')

			await this.bot.dig(targetBlock)
			this.currentAction.type = 'idle'
			return { ok: true, msg: `Mined ${targetBlock.name} at [${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z}].` }
		} catch (err)
		{
			this.currentAction.type = 'idle'
			return { ok: false, msg: `Mine failed: ${err.message}` }
		}
	}

	async placeBlock(itemName)
	{
		const item = this.bot.inventory.items().find(i =>
			i.name.toLowerCase().includes(String(itemName).toLowerCase())
		)
		if (!item) return { ok: false, msg: `No "${itemName}" in inventory.` }

		const action = this._startAction('placing')

		try
		{
			// 1) findBlocks restituisce Vec3[], NON Block[]
			const candidatePositions = this.bot.findBlocks({
				matching: b =>
					b.name !== 'air' &&
					b.name !== 'water' &&
					b.name !== 'lava' &&
					b.name !== 'cave_air' &&
					b.name !== 'void_air' &&
					!b.name.includes('torch') &&
					!b.name.includes('flower') &&
					!b.name.includes('grass') &&
					!b.name.includes('rail') &&
					!b.name.includes('sign') &&
					!b.name.includes('banner') &&
					!b.name.includes('button') &&
					!b.name.includes('carpet'),
				maxDistance: 4,
				count: 32
			})

			if (!candidatePositions.length)
				return { ok: false, msg: 'No solid block nearby to place against.' }

			const FACES = [
				new Vec3(0, 1, 0),   // sopra
				new Vec3(0, -1, 0),  // sotto
				new Vec3(1, 0, 0),   // est
				new Vec3(-1, 0, 0),  // ovest
				new Vec3(0, 0, 1),   // sud
				new Vec3(0, 0, -1)   // nord
			]

			const botPos = this.bot.entity.position
			const eyePos = botPos.offset(0, this.bot.entity.height, 0)
			let best = null

			for (const refPos of candidatePositions)
			{
				// refPos è già un Vec3 -> qui recupero il Block vero
				const refBlock = this.bot.blockAt(refPos)
				if (!refBlock) continue

				for (const face of FACES)
				{
					const targetPos = refPos.plus(face)
					const targetBlock = this.bot.blockAt(targetPos)

					if (!targetBlock) continue
					if (targetBlock.name !== 'air' && !targetBlock.name.includes('water')) continue

					// Distanza dall'occhio al centro del target
					const dist = eyePos.distanceTo(targetPos.offset(0.5, 0.5, 0.5))
					if (dist > 4.5) continue

					// Nessuna entità che occupa lo spazio
					const occupied = Object.values(this.bot.entities).some(e =>
					{
						if (!e || e === this.bot.entity) return false
						if (!e.position) return false
						const dx = Math.abs(e.position.x - (targetPos.x + 0.5))
						const dy = Math.abs(e.position.y - targetPos.y)
						const dz = Math.abs(e.position.z - (targetPos.z + 0.5))
						return dx < 0.9 && dz < 0.9 && dy < 1.9
					})
					if (occupied) continue

					best = { refBlock, refPos, face, targetPos, targetBlock, dist }
					break
				}
				if (best) break
			}

			if (!best)
				return { ok: false, msg: 'No valid placement spot found nearby (blocked or too far).' }

			if (action.isCancelled()) return { ok: false, msg: 'Place cancelled.' }

			// 2) Equipaggia e guarda verso il refBlock
			await this.bot.equip(item, 'hand')
			await this.bot.lookAt(best.refBlock.position.offset(0.5, 0.5, 0.5), true)

			// 3) Piazza
			await this.bot.placeBlock(best.refBlock, best.face)

			this.currentAction.type = 'idle'
			return {
				ok: true,
				msg: `Placed ${item.name} at [${best.targetPos.x}, ${best.targetPos.y}, ${best.targetPos.z}] on face of ${best.refBlock.name}.`
			}
		}
		catch (err)
		{
			this.currentAction.type = 'idle'
			return { ok: false, msg: `Place failed: ${err.message}` }
		}
	}

	async equip(itemName, destination = 'hand')
	{
		const item = this.bot.inventory.items().find(i => i.name.toLowerCase().includes(itemName.toLowerCase()))
		if (!item) return { ok: false, msg: `Item "${itemName}" not found.` }

		try
		{
			await this.bot.equip(item, destination)
			return { ok: true, msg: `Equipped ${item.name} to ${destination}.` }
		} catch (err)
		{
			return { ok: false, msg: `Equip failed: ${err.message}` }
		}
	}

	async look(yaw, pitch)
	{
		try
		{
			await this.bot.look(yaw, pitch, true)
			return { ok: true, msg: `Looking at yaw:${yaw.toFixed(1)} pitch:${pitch.toFixed(1)}.` }
		} catch (err)
		{
			return { ok: false, msg: `Look failed: ${err.message}` }
		}
	}

	/* ---------------- Collect / Gather / Craft / Smelt ---------------- */

	async collect(itemName, amount = 1)
	{
		const target = String(itemName).toLowerCase()
		const wanted = Math.max(1, Math.floor(amount))
		const action = this._startAction('collecting')

		let collected = 0
		const deadline = Date.now() + this.cfg.movementTimeout

		try
		{
			while (collected < wanted)
			{
				if (action.isCancelled() || Date.now() > deadline)
				{
					this.currentAction.type = 'idle'
					return {
						ok: false,
						msg: `Collect interrupted after ${collected}/${wanted} ${target}.`
					}
				}

				const block = this.bot.findBlock({
					matching: b => b.name.toLowerCase().includes(target),
					maxDistance: 24
				})

				if (block)
				{
					await this.bot.pathfinder.goto(
						new goals.GoalLookAtBlock(block.position, this.bot.world)
					)
					if (action.isCancelled()) return { ok: false, msg: 'Collect cancelled.' }

					const tool = this.bot.pathfinder.getBestHarvestTool(block)
					if (tool) await this.bot.equip(tool, 'hand')
					await this.bot.dig(block)
					collected++
					continue
				}

				const drop = Object.values(this.bot.entities).find(e =>
					(e.name === 'item' || e.type === 'object') &&
					e.position &&
					e.position.distanceTo(this.bot.entity.position) <= 24
				)

				if (drop)
				{
					await this.bot.pathfinder.goto(
						new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1)
					)
					await this._sleep(300)
					collected++
					continue
				}

				this.currentAction.type = 'idle'
				if (collected === 0)
					return { ok: false, msg: `No ${target} found nearby.` }

				return {
					ok: true,
					msg: `Collected ${collected}/${wanted} ${target} (source exhausted).`
				}
			}

			this.currentAction.type = 'idle'
			return { ok: true, msg: `Collected ${collected}/${wanted} ${target}.` }
		}
		catch (err)
		{
			this.currentAction.type = 'idle'
			return {
				ok: false,
				msg: `Collect failed after ${collected}/${wanted}: ${err.message}`
			}
		}
	}

	async gather(blockName, amount = 1)
	{
		return this.collect(blockName, amount)
	}

	async craft(itemName, amount = 1)
	{
		const wanted = Math.max(1, Math.floor(amount))
		const action = this._startAction('crafting')

		try
		{
			const itemId = this._resolveItemId(itemName)
			if (itemId == null)
			{
				this.currentAction.type = 'idle'
				return { ok: false, msg: `Unknown item "${itemName}".` }
			}

			const recipes = this.bot.recipesFor(itemId, null, 1, null)
			if (!recipes || !recipes.length)
			{
				this.currentAction.type = 'idle'
				return { ok: false, msg: `No recipe for "${itemName}".` }
			}

			const recipe = recipes[0]
			const times = Math.ceil(wanted / (recipe.result?.count || 1))

			let crafted = 0
			for (let i = 0; i < times; i++)
			{
				if (action.isCancelled())
				{
					this.currentAction.type = 'idle'
					return { ok: false, msg: 'Craft cancelled.' }
				}

				if (!recipe.requiresTable)
				{
					await this.bot.craft(recipe, 1, null)
				}
				else
				{
					const tableBlock = this.bot.findBlock({
						matching: b => b.name === 'crafting_table',
						maxDistance: 8
					})
					if (!tableBlock)
					{
						this.currentAction.type = 'idle'
						return { ok: false, msg: 'No crafting table nearby.' }
					}

					await this.bot.pathfinder.goto(
						new goals.GoalNear(
							tableBlock.position.x,
							tableBlock.position.y,
							tableBlock.position.z,
							2
						)
					)
					await this.bot.craft(recipe, 1, tableBlock)
				}

				crafted += recipe.result?.count || 1
			}

			this.currentAction.type = 'idle'
			return { ok: true, msg: `Crafted ${crafted}x ${itemName}.` }
		}
		catch (err)
		{
			this.currentAction.type = 'idle'
			return { ok: false, msg: `Craft failed: ${err.message}` }
		}
	}

	async smelt(itemName, amount = 1)
	{
		const wanted = Math.max(1, Math.floor(amount))
		const action = this._startAction('smelting')

		try
		{
			const inputItem = this.bot.inventory.items()
				.find(i => i.name.toLowerCase().includes(String(itemName).toLowerCase()))
			if (!inputItem)
			{
				this.currentAction.type = 'idle'
				return { ok: false, msg: `No "${itemName}" in inventory.` }
			}

			const furnaceBlock = this.bot.findBlock({
				matching: b => b.name === 'furnace' || b.name === 'blast_furnace' || b.name === 'smoker',
				maxDistance: 8
			})
			if (!furnaceBlock)
			{
				this.currentAction.type = 'idle'
				return { ok: false, msg: 'No furnace nearby.' }
			}

			await this.bot.pathfinder.goto(
				new goals.GoalNear(
					furnaceBlock.position.x,
					furnaceBlock.position.y,
					furnaceBlock.position.z,
					2
				)
			)
			if (action.isCancelled()) return { ok: false, msg: 'Smelt cancelled.' }

			const furnace = await this.bot.openFurnace(furnaceBlock)

			const fuelNames = new Set([
				'coal', 'charcoal', 'oak_planks', 'spruce_planks', 'birch_planks',
				'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'oak_log',
				'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
				'stick', 'lava_bucket', 'blaze_rod', 'dried_kelp_block', 'coal_block'
			])
			const fuel = this.bot.inventory.items().find(i => fuelNames.has(i.name))
			if (fuel) await furnace.putFuel(fuel.type, null, 1)

			const putCount = Math.min(wanted, inputItem.count)
			await furnace.putInput(inputItem.type, null, putCount)

			const smeltTime = 10000 * Math.ceil(putCount / 8)
			const start = Date.now()
			while (Date.now() - start < smeltTime)
			{
				if (action.isCancelled()) break
				await this._sleep(500)
			}

			await furnace.takeOutput()
			furnace.close()

			this.currentAction.type = 'idle'
			return { ok: true, msg: `Smelted up to ${putCount}x ${itemName}.` }
		}
		catch (err)
		{
			this.currentAction.type = 'idle'
			return { ok: false, msg: `Smelt failed: ${err.message}` }
		}
	}

	/* ---------------- Containers ---------------- */

	async _openNearbyContainer(containerName = 'chest', maxDistance = 8)
	{
		const wanted = String(containerName || 'chest').toLowerCase()
		const block = this.bot.findBlock({
			matching: b =>
			{
				const n = b.name.toLowerCase()
				return n.includes(wanted) &&
					(n.includes('chest') || n.includes('barrel') ||
						n.includes('shulker') || n.includes('furnace') ||
						n.includes('hopper') || n.includes('dispenser') ||
						n.includes('dropper'))
			},
			maxDistance
		})
		if (!block) return null

		await this.bot.pathfinder.goto(
			new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)
		)
		return this.bot.openContainer(block)
	}

	async deposit(containerName = 'chest', itemName = null, amount = null)
	{
		const action = this._startAction('depositing')
		try
		{
			const container = await this._openNearbyContainer(containerName)
			if (!container)
			{
				this.currentAction.type = 'idle'
				return { ok: false, msg: `No ${containerName} nearby.` }
			}
			if (action.isCancelled())
			{
				container.close()
				return { ok: false, msg: 'Deposit cancelled.' }
			}

			let deposited = 0
			const invItems = this.bot.inventory.items()

			const targets = itemName
				? invItems.filter(i => i.name.toLowerCase().includes(String(itemName).toLowerCase()))
				: invItems

			for (const item of targets)
			{
				const remaining = amount != null ? amount - deposited : Infinity
				if (remaining <= 0) break
				const count = Math.min(remaining, item.count)
				await container.deposit(item.type, null, count)
				deposited += count
			}

			container.close()
			this.currentAction.type = 'idle'
			return { ok: true, msg: `Deposited ${deposited} item(s) into ${containerName}.` }
		}
		catch (err)
		{
			this.currentAction.type = 'idle'
			return { ok: false, msg: `Deposit failed: ${err.message}` }
		}
	}

	async withdraw(itemName, amount = 1, containerName = null)
	{
		const wanted = Math.max(1, Math.floor(amount))
		const action = this._startAction('withdrawing')

		try
		{
			const container = await this._openNearbyContainer(containerName || 'chest')
			if (!container)
			{
				this.currentAction.type = 'idle'
				return { ok: false, msg: 'No container nearby.' }
			}
			if (action.isCancelled())
			{
				container.close()
				return { ok: false, msg: 'Withdraw cancelled.' }
			}

			const slotItem = container.containerItems()
				.find(i => i.name.toLowerCase().includes(String(itemName).toLowerCase()))
			if (!slotItem)
			{
				container.close()
				this.currentAction.type = 'idle'
				return { ok: false, msg: `"${itemName}" not found in container.` }
			}

			const count = Math.min(wanted, slotItem.count)
			await container.withdraw(slotItem.type, null, count)
			container.close()

			this.currentAction.type = 'idle'
			return { ok: true, msg: `Withdrew ${count}x ${slotItem.name}.` }
		}
		catch (err)
		{
			this.currentAction.type = 'idle'
			return { ok: false, msg: `Withdraw failed: ${err.message}` }
		}
	}

	/* ---------------- Homes Management ---------------- */

	async setHome(name = 'default')
	{
		const homeName = String(name).trim().toLowerCase()

		if (!homeName)
		{
			return { ok: false, msg: 'Home name cannot be empty.' }
		}

		if (!this.bot.entity?.position)
		{
			return { ok: false, msg: 'Bot position is not available.' }
		}

		const pos = this.bot.entity.position
		const dimension = String(
			this.bot.game?.dimension || 'overworld'
		).replace('minecraft:', '')

		const home = {
			name: homeName,
			x: Math.floor(pos.x),
			y: Math.floor(pos.y),
			z: Math.floor(pos.z),
			dimension
		}

		this.homes.set(homeName, home)

		// MODIFICA: Salva lo stato su file locale dopo ogni aggiunta/modifica
		await this._saveState()

		return {
			ok: true,
			msg: `Home "${homeName}" set at [${home.x}, ${home.y}, ${home.z}] (${home.dimension}) e salvato su disco.`,
			data: home
		}
	}

	async goHome(name = 'default')
	{
		const homeName = String(name).trim().toLowerCase()
		const home = this.homes.get(homeName)

		if (!home)
		{
			return { ok: false, msg: `Home "${homeName}" not found.` }
		}

		const currentDimension = String(
			this.bot.game?.dimension || 'overworld'
		).replace('minecraft:', '')

		if (currentDimension !== home.dimension)
		{
			return {
				ok: false,
				msg: `Home "${homeName}" is in ${home.dimension}, current dimension is ${currentDimension}.`
			}
		}

		return this.goto(home.x, home.y, home.z)
	}

	// MODIFICA: Reso async per poter attendere il salvataggio su file
	async deleteHome(name = 'default')
	{
		const homeName = String(name).trim().toLowerCase()

		if (!this.homes.has(homeName))
		{
			return { ok: false, msg: `Home "${homeName}" not found.` }
		}

		this.homes.delete(homeName)

		// MODIFICA: Salva lo stato su file locale dopo ogni eliminazione
		await this._saveState()

		return {
			ok: true,
			msg: `Home "${homeName}" deleted e rimosso dal file di stato.`
		}
	}

	listHomes()
	{
		const homes = [...this.homes.values()]

		if (!homes.length)
		{
			return {
				ok: true,
				msg: 'No homes saved.',
				data: []
			}
		}

		const summary = homes
			.map(home =>
				`${home.name}: [${home.x}, ${home.y}, ${home.z}] (${home.dimension})`
			)
			.join(', ')

		return {
			ok: true,
			msg: summary,
			data: homes
		}
	}

	/* ---------------- Markers (Waypoints) ---------------- */

	async markLocation(name)
	{
		const markerName = String(name).trim().toLowerCase()
		if (!markerName) return { ok: false, msg: 'Marker name cannot be empty.' }

		const pos = this.bot.entity?.position
		if (!pos) return { ok: false, msg: 'Bot position not available.' }

		const dimension = String(this.bot.game?.dimension || 'overworld')
			.replace('minecraft:', '')

		const marker = {
			name: markerName,
			x: Math.floor(pos.x),
			y: Math.floor(pos.y),
			z: Math.floor(pos.z),
			dimension
		}
		this.markers.set(markerName, marker)

		// MODIFICA: Salva lo stato su file locale dopo ogni aggiunta/modifica
		await this._saveState()

		return {
			ok: true,
			msg: `Marker "${markerName}" set at [${marker.x}, ${marker.y}, ${marker.z}] (${marker.dimension}) e salvato su disco.`,
			data: marker
		}
	}

	async goToMarker(name)
	{
		const markerName = String(name).trim().toLowerCase()
		const marker = this.markers.get(markerName)
		if (!marker) return { ok: false, msg: `Marker "${markerName}" not found.` }

		const currentDim = String(this.bot.game?.dimension || 'overworld')
			.replace('minecraft:', '')

		if (currentDim !== marker.dimension)
		{
			return {
				ok: false,
				msg: `Marker "${markerName}" is in ${marker.dimension}, current is ${currentDim}.`
			}
		}

		return this.goto(marker.x, marker.y, marker.z)
	}

	// MODIFICA: Reso async per poter attendere il salvataggio su file
	async deleteMarker(name)
	{
		const markerName = String(name).trim().toLowerCase()
		if (!this.markers.has(markerName))
		{
			return { ok: false, msg: `Marker "${markerName}" not found.` }
		}

		this.markers.delete(markerName)

		// MODIFICA: Salva lo stato su file locale dopo ogni eliminazione
		await this._saveState()

		return { ok: true, msg: `Marker "${markerName}" deleted e rimosso dal file di stato.` }
	}

	/* ---------------- Combat & Protection ---------------- */

	async attack(targetName)
	{
		const action = this._startAction('attacking')
		const target = this._resolveEntity(targetName)
		if (!target)
		{
			this.currentAction.type = 'idle'
			return { ok: false, msg: `Target "${targetName}" not found nearby.` }
		}

		try
		{
			const weapon = this.bot.inventory.items()
				.filter(i => /sword|axe/.test(i.name))
				.sort((a, b) => (b.attackDamage || 0) - (a.attackDamage || 0))[0]
			if (weapon) await this.bot.equip(weapon, 'hand')

			await this.bot.pathfinder.goto(new goals.GoalFollow(target, 2))
			if (action.isCancelled())
			{
				this.currentAction.type = 'idle'
				return { ok: false, msg: 'Attack cancelled.' }
			}

			let hits = 0
			const deadline = Date.now() + 15000
			while (target.isValid && Date.now() < deadline && hits < 30)
			{
				if (action.isCancelled()) break
				await this.bot.lookAt(target.position.offset(0, 1.5, 0), true)
				this.bot.attack(target)
				hits++
				await this._sleep(600)
			}

			this.currentAction.type = 'idle'
			return {
				ok: true,
				msg: target.isValid
					? `Attacked ${targetName} ${hits} times.`
					: `Killed/defeated ${targetName}.`
			}
		}
		catch (err)
		{
			this.currentAction.type = 'idle'
			return { ok: false, msg: `Attack failed: ${err.message}` }
		}
	}

	async protect(playerName)
	{
		const target = this._resolvePlayerEntity(playerName)
		if (!target) return { ok: false, msg: `Player "${playerName}" not visible.` }

		this._startAction('protecting')
		this._protectTarget = playerName

		const loop = async () =>
		{
			while (
				this.currentAction.type === 'protecting' &&
				this._protectTarget === playerName
			)
			{
				const p = this._resolvePlayerEntity(playerName)
				if (!p) break

				try
				{
					this.bot.pathfinder.setGoal(new goals.GoalFollow(p, 3), true)
				} catch (_) { /* ignore */ }

				const threats = Object.values(this.bot.entities).filter(e =>
				{
					if (!e || e === this.bot.entity) return false
					if (e.type !== 'mob' && e.type !== 'hostile') return false
					if (!e.position) return false
					return e.position.distanceTo(p.position) <= 6
				})

				if (threats.length)
				{
					const nearest = threats[0]
					try
					{
						await this.bot.lookAt(nearest.position.offset(0, 1, 0), true)
						this.bot.attack(nearest)
					} catch (_) { /* ignore */ }
				}

				await this._sleep(700)
			}
		}

		loop().catch(() => { })

		return { ok: true, msg: `Protecting ${playerName}.` }
	}

	async avoid(entityName, duration = 60000)
	{
		const name = String(entityName).toLowerCase()
		const until = Date.now() + Math.max(1000, duration)
		this._avoid.set(name, until)

		const timer = setTimeout(() => this._avoid.delete(name), duration)
		if (timer.unref) timer.unref()

		return { ok: true, msg: `Avoiding "${name}" for ${Math.round(duration / 1000)}s.` }
	}

	/* ---------------- Cancel / Panic / Unstuck ---------------- */

	async cancel()
	{
		if (this.currentAction.cancel) this.currentAction.cancel()
		this.currentAction = { type: 'idle', id: ++this.actionCounter, cancel: null }

		if (this.bot.pathfinder)
		{
			this.bot.pathfinder.stop()
			this.bot.pathfinder.setGoal(null)
		}
		this.bot.clearControlStates()
		this._currentTask = null
		this._protectTarget = null

		return { ok: true, msg: 'Current task and pathfinding cancelled.' }
	}

	async panic()
	{
		if (this.currentAction.cancel) this.currentAction.cancel()
		this.currentAction = { type: 'idle', id: ++this.actionCounter, cancel: null }
		if (this.bot.pathfinder)
		{
			this.bot.pathfinder.stop()
			this.bot.pathfinder.setGoal(null)
		}

		const action = this._startAction('panicking')

		try
		{
			if (this.bot.food < 20)
			{
				const food = this.bot.inventory.items().find(i => EDIBLE_FOODS.has(i.name))
				if (food)
				{
					try
					{
						await this.bot.equip(food, 'hand')
						await this.bot.consume()
					} catch (_) { /* ignore */ }
				}
			}

			if (action.isCancelled())
			{
				this.currentAction.type = 'idle'
				return { ok: false, msg: 'Panic cancelled.' }
			}

			const threats = this.getThreats(16).data || []
			if (threats.length > 0)
			{
				const botPos = this.bot.entity.position
				const nearest = threats[0]
				const dx = botPos.x - nearest.position[0]
				const dz = botPos.z - nearest.position[2]
				const len = Math.hypot(dx, dz) || 1
				const fleeX = botPos.x + (dx / len) * 12
				const fleeZ = botPos.z + (dz / len) * 12

				try
				{
					await this.bot.pathfinder.goto(
						new goals.GoalXZ(Math.floor(fleeX), Math.floor(fleeZ))
					)
				} catch (_) { /* best effort */ }
			}

			if (action.isCancelled())
			{
				this.currentAction.type = 'idle'
				return { ok: false, msg: 'Panic cancelled.' }
			}

			const shelter = this.bot.findBlock({
				matching: b => b.name !== 'air' &&
					!b.name.includes('water') &&
					!b.name.includes('lava') &&
					b.name !== 'torch',
				maxDistance: 8
			})

			if (shelter)
			{
				try
				{
					await this.bot.pathfinder.goto(
						new goals.GoalNear(
							shelter.position.x,
							shelter.position.y,
							shelter.position.z,
							1
						)
					)
				} catch (_) { /* best effort */ }
			}

			this.currentAction.type = 'idle'
			return { ok: true, msg: 'Panic: danger avoided, sought shelter.' }
		}
		catch (err)
		{
			this.currentAction.type = 'idle'
			return { ok: false, msg: `Panic failed: ${err.message}` }
		}
	}

	async unstuck()
	{
		const action = this._startAction('unstuck')

		try
		{
			this.bot.setControlState('jump', true)
			await this._sleep(400)
			this.bot.setControlState('jump', false)

			if (action.isCancelled())
			{
				this.currentAction.type = 'idle'
				return { ok: false, msg: 'Unstuck cancelled.' }
			}

			const dirs = ['forward', 'back', 'left', 'right']
			for (const dir of dirs)
			{
				this.bot.setControlState(dir, true)
				await this._sleep(350)
				this.bot.setControlState(dir, false)
				if (action.isCancelled())
				{
					this.currentAction.type = 'idle'
					return { ok: false, msg: 'Unstuck cancelled.' }
				}
			}

			if (this.bot.pathfinder)
			{
				this.bot.pathfinder.stop()
				this.bot.pathfinder.setGoal(null)
			}

			this.currentAction.type = 'idle'
			return { ok: true, msg: 'Unstuck attempts performed.' }
		}
		catch (err)
		{
			this.currentAction.type = 'idle'
			return { ok: false, msg: `Unstuck failed: ${err.message}` }
		}
	}

	/* ---------------- Pause / Resume / Task ---------------- */

	async pause()
	{
		if (this._paused) return { ok: true, msg: 'Already paused.' }

		this._paused = true
		if (this.bot.pathfinder)
		{
			this.bot.pathfinder.stop()
			this.bot.pathfinder.setGoal(null)
		}
		if (this._currentTask) this._currentTask.paused = true

		return { ok: true, msg: 'Task paused.' }
	}

	async resume()
	{
		if (!this._paused) return { ok: true, msg: 'Not paused.' }

		this._paused = false
		if (this._currentTask) this._currentTask.paused = false

		return { ok: true, msg: 'Task resumed.' }
	}

	getTaskStatus()
	{
		const action = this.currentAction.type
		const task = this._currentTask

		if (!task)
		{
			return {
				ok: true,
				msg: `Idle. Current action: ${action}.`,
				data: { action, task: null, paused: this._paused }
			}
		}

		return {
			ok: true,
			msg: `Task "${task.description}" — ${task.paused ? 'paused' : 'running'}. Action: ${action}.`,
			data: {
				action,
				task: task.description,
				paused: task.paused,
				startedAt: task.startedAt,
				elapsedMs: Date.now() - task.startedAt
			}
		}
	}

	async runTask(description)
	{
		if (this._currentTask && !this._currentTask.paused)
		{
			return { ok: false, msg: 'A task is already running. Cancel it first.' }
		}

		this._startAction('task')
		this._currentTask = {
			description: String(description),
			paused: false,
			startedAt: Date.now()
		}

		try
		{
			const d = String(description).toLowerCase()
			let result

			if (/\b(mine|mina|scava)\b/.test(d))
			{
				const m = d.match(/(iron_ore|oak_log|stone|coal_ore|diamond_ore|gold_ore|[a-z_]+)/)
				result = await this.mine(m ? m[1] : 'stone')
			}
			else if (/\b(gather|collect|raccogli)\b/.test(d))
			{
				const m = d.match(/(\d+)\s*(?:x\s*)?([a-z_]+)/)
				const amount = m ? parseInt(m[1], 10) : 1
				const item = m ? m[2] : 'oak_log'
				result = await this.collect(item, amount)
			}
			else if (/\b(craft|crea)\b/.test(d))
			{
				const m = d.match(/(\d+)\s*(?:x\s*)?([a-z_]+)/)
				const amount = m ? parseInt(m[1], 10) : 1
				const item = m ? m[2] : 'crafting_table'
				result = await this.craft(item, amount)
			}
			else if (/\b(eat|mangia)\b/.test(d))
			{
				result = await this.eat()
			}
			else if (/\b(sleep|dormi)\b/.test(d))
			{
				result = await this.sleep()
			}
			else if (/\b(go home|vai a casa)\b/.test(d))
			{
				result = await this.goHome('default')
			}
			else
			{
				result = {
					ok: false,
					msg: `Cannot interpret task: "${description}".`
				}
			}

			this.currentAction.type = 'idle'
			this._currentTask = null
			return result
		}
		catch (err)
		{
			this.currentAction.type = 'idle'
			this._currentTask = null
			return { ok: false, msg: `Task failed: ${err.message}` }
		}
	}

	/* ---------------- Inspection & State Reporting ---------------- */

	getStatus()
	{
		const pos = this.bot.entity?.position || new Vec3(0, 0, 0)
		return {
			ok: true,
			data: {
				pos: [Math.round(pos.x), Math.round(pos.y), Math.round(pos.z)],
				dim: (this.bot.game?.dimension || 'overworld').replace('minecraft:', ''),
				hp: Math.round(this.bot.health || 0),
				food: Math.round(this.bot.food || 0),
				oxy: Math.round(this.bot.oxygenLevel || 20),
				action: this.currentAction.type
			}
		}
	}

	getInventory(details = false)
	{
		const items = this.bot.inventory.items()
		if (!items.length) return { ok: true, msg: 'Inventory empty.', data: [] }

		const grouped = {}
		for (const it of items)
		{
			grouped[it.name] = (grouped[it.name] || 0) + it.count
		}

		const compactList = Object.entries(grouped).map(([name, count]) => `${count}x ${name}`)
		return {
			ok: true,
			msg: compactList.join(', '),
			data: details ? items.map(i => ({ slot: i.slot, name: i.name, count: i.count })) : grouped
		}
	}

	getNearbyEntities(maxDistance = 16)
	{
		const entities = Object.values(this.bot.entities)
			.filter(e => e !== this.bot.entity && e.position && this.bot.entity?.position &&
				e.position.distanceTo(this.bot.entity.position) <= maxDistance)
			.map(e => ({
				type: e.type,
				name: e.name || e.username || 'unknown',
				dist: Math.round(e.position.distanceTo(this.bot.entity.position))
			}))
			.slice(0, 10)

		return { ok: true, data: entities }
	}

	getThreats(maxDistance = 24)
	{
		const radius = Number(maxDistance)

		if (!Number.isFinite(radius) || radius <= 0)
		{
			return {
				ok: false,
				msg: 'Threat radius must be a positive number.',
				data: []
			}
		}

		const hostileNames = new Set([
			'blaze', 'bogged', 'breeze', 'creaking', 'creeper', 'drowned',
			'elder_guardian', 'ender_dragon', 'endermite', 'evoker', 'ghast',
			'guardian', 'hoglin', 'husk', 'magma_cube', 'phantom', 'piglin_brute',
			'pillager', 'ravager', 'shulker', 'silverfish', 'skeleton', 'slime',
			'spider', 'stray', 'vex', 'vindicator', 'warden', 'witch', 'wither',
			'wither_skeleton', 'zoglin', 'zombie', 'zombie_villager', 'zombified_piglin'
		])

		const botPosition = this.bot.entity?.position

		if (!botPosition)
		{
			return {
				ok: false,
				msg: 'Bot position is not available.',
				data: []
			}
		}

		const threats = Object.values(this.bot.entities)
			.filter(entity =>
			{
				if (!entity || entity === this.bot.entity) return false
				if (!entity.position) return false

				const name = String(
					entity.name || entity.mobType || entity.displayName || ''
				)
					.toLowerCase()
					.replace('minecraft:', '')
					.replace(/ /g, '_')

				if (!hostileNames.has(name)) return false

				return entity.position.distanceTo(botPosition) <= radius
			})
			.map(entity =>
			{
				const name = String(
					entity.name || entity.mobType || entity.displayName || 'unknown'
				)
					.toLowerCase()
					.replace('minecraft:', '')
					.replace(/ /g, '_')

				const distance = entity.position.distanceTo(botPosition)

				return {
					id: entity.id,
					name,
					type: entity.type || 'mob',
					distance: Math.round(distance * 10) / 10,
					position: [
						Math.floor(entity.position.x),
						Math.floor(entity.position.y),
						Math.floor(entity.position.z)
					],
					health: typeof entity.health === 'number' ? entity.health : null
				}
			})
			.sort((a, b) => a.distance - b.distance)

		if (!threats.length)
		{
			return {
				ok: true,
				msg: `No hostile entities within ${radius} blocks.`,
				data: []
			}
		}

		const summary = threats
			.map(threat => `${threat.name}(${threat.distance}m)`)
			.join(', ')

		return {
			ok: true,
			msg: `Threats within ${radius} blocks: ${summary}.`,
			data: threats
		}
	}

	/* ---------------- Internal Helpers ---------------- */

	_sleep(ms)
	{
		return new Promise(resolve => setTimeout(resolve, ms))
	}

	_resolvePlayerEntity(playerName)
	{
		if (!playerName) return null
		const playerObj = this.bot.players[playerName] ||
			Object.values(this.bot.players).find(
				p => p.username.toLowerCase() === playerName.toLowerCase()
			)
		return playerObj?.entity || null
	}

	_resolveEntity(targetName)
	{
		const name = String(targetName).toLowerCase()

		const playerEntity = this._resolvePlayerEntity(targetName)
		if (playerEntity) return playerEntity

		return Object.values(this.bot.entities).find(e =>
		{
			if (!e || e === this.bot.entity) return false
			const n = String(e.name || e.mobType || e.displayName || '')
				.toLowerCase()
				.replace('minecraft:', '')
				.replace(/ /g, '_')
			return n === name || n.includes(name)
		}) || null
	}

	_resolveItemId(itemName)
	{
		const name = String(itemName).toLowerCase()
		const items = this.bot.registry?.items || {}

		for (const id of Object.keys(items))
		{
			const it = items[id]
			if (it && it.name && it.name.toLowerCase() === name) return it.id
		}
		for (const id of Object.keys(items))
		{
			const it = items[id]
			if (it && it.name && it.name.toLowerCase().includes(name)) return it.id
		}
		return null
	}

	_parseSleepError(msg)
	{
		const m = String(msg).toLowerCase()
		if (m.includes('occupied')) return 'Bed occupied'
		if (m.includes('too far')) return 'Too far from bed'
		if (m.includes('monster')) return 'Monsters nearby'
		if (m.includes('night') || m.includes('thunder')) return 'Not night or storm'
		if (m.includes('obstructed')) return 'Bed obstructed'
		return msg
	}
}

module.exports = ActionManager
