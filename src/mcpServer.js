'use strict'

const express = require('express')
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')
const { z } = require('zod')

let serverInstance = null

function createServer(getActionManager)
{
	const server = new McpServer({
		name: 'minecraft-bot',
		version: '1.0.0'
	})

	const getMgr = () =>
	{
		const mgr = getActionManager()
		if (!mgr) throw new Error('Bot is currently disconnected or reconnecting.')
		return mgr
	}

	// --- Tool Definitions (Compact responses for 7–8B LLMs) ---

	server.registerTool(
		'get_status',
		{
			description: 'Get current bot coordinates, dimension, health, hunger, and action',
			inputSchema: {}
		},
		async () =>
		{
			const res = getMgr().getStatus()

			return {
				content: [
					{
						type: 'text',
						text: JSON.stringify(res.data)
					}
				]
			}
		}
	)

	server.registerTool(
		'navigate',
		{
			description: 'Walk to XYZ coordinates or to a visible player',
			inputSchema: {
				x: z.number().optional().describe('Target X coordinate'),
				y: z.number().optional().describe('Target Y coordinate'),
				z: z.number().optional().describe('Target Z coordinate'),
				player: z.string().optional().describe('Target player username')
			}
		},
		async ({ x, y, z, player }) =>
		{
			const mgr = getMgr()

			const res = player
				? await mgr.come(player)
				: await mgr.goto(x, y, z)

			return {
				content: [
					{
						type: 'text',
						text: res.msg
					}
				]
			}
		}
	)

	server.registerTool(
		'stop',
		{
			description: 'Immediately stop current task and clear pathfinding',
			inputSchema: {}
		},
		async () =>
		{
			const res = getMgr().stop()

			return {
				content: [
					{
						type: 'text',
						text: res.msg
					}
				]
			}
		}
	)

	server.registerTool(
		'get_inventory',
		{
			description: 'List items in bot inventory',
			inputSchema: {}
		},
		async () =>
		{
			const res = getMgr().getInventory(false)

			return {
				content: [
					{
						type: 'text',
						text: res.msg
					}
				]
			}
		}
	)

	server.registerTool(
		'mine',
		{
			description: 'Search for and mine a specific block type nearby',
			inputSchema: {
				block: z.string().describe('Name of the block to find and mine (e.g. "iron_ore", "oak_log")')
			}
		},
		async ({ block }) =>
		{
			const res = await getMgr().mine(block)

			return {
				content: [
					{
						type: 'text',
						text: res.msg
					}
				]
			}
		}
	)

	server.registerTool(
		'place',
		{
			description: 'Place a block from inventory into the world',
			inputSchema: {
				block: z.string().describe('Name of the block to place (e.g. "cobblestone", "dirt")')
			}
		},
		async ({ block }) =>
		{
			const res = await getMgr().placeBlock(block)

			return {
				content: [
					{
						type: 'text',
						text: res.msg
					}
				]
			}
		}
	)

	server.registerTool(
		'eat',
		{
			description: 'Eat food from inventory to restore hunger',
			inputSchema: {}
		},
		async () =>
		{
			const res = await getMgr().eat()

			return {
				content: [
					{
						type: 'text',
						text: res.msg
					}
				]
			}
		}
	)

	server.registerTool(
		'sleep',
		{
			description: 'Find the nearest bed and sleep',
			inputSchema: {}
		},
		async () =>
		{
			const res = await getMgr().sleep()

			return {
				content: [
					{
						type: 'text',
						text: res.msg
					}
				]
			}
		}
	)

	server.registerTool(
		'echo',
		{
			description: 'Ripete il messaggio ricevuto direttamente nella chat e nella console',
			inputSchema: {
				message: z.string().describe('Messaggio da ripetere')
			}
		},
		async ({ message }) =>
		{
			console.log(`[echo] ${message}`)

			try
            {
                // La chat MC non accetta newline e tronca ~256 char
                mgr.bot.chat(String(message).replace(/\n/g, ' ').slice(0, 256))
            } catch (err)
            {
                return { content: [{ type: 'text', text: `Chat failed: ${err.message}` }] }
            }

			return {
				content: [
					{
						type: 'text',
						text: message
					}
				]
			}
		}
	)

	server.registerTool(
		'cancel',
		{
			description: 'Cancel the current task and stop all ongoing actions',
			inputSchema: {}
		},
		async () =>
		{
			const mgr = getMgr()
			const res = mgr.cancel
				? await mgr.cancel()
				: mgr.stop()

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'panic',
		{
			description: 'Emergency behavior: stop the current task, escape danger and seek safety',
			inputSchema: {}
		},
		async () =>
		{
			const res = await getMgr().panic()

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'unstuck',
		{
			description: 'Attempt to free the bot when it is stuck',
			inputSchema: {}
		},
		async () =>
		{
			const res = await getMgr().unstuck()

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'collect',
		{
			description: 'Collect a specified amount of an item from the world',
			inputSchema: {
				item: z.string().describe('Item or block name to collect'),
				amount: z.number().int().positive().default(1)
					.describe('Amount to collect')
			}
		},
		async ({ item, amount }) =>
		{
			const res = await getMgr().collect(item, amount)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'gather',
		{
			description: 'Mine or gather a specified amount of a block type',
			inputSchema: {
				block: z.string().describe('Block name to gather'),
				amount: z.number().int().positive().default(1)
					.describe('Amount to gather')
			}
		},
		async ({ block, amount }) =>
		{
			const res = await getMgr().gather(block, amount)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'craft',
		{
			description: 'Craft a specified amount of an item',
			inputSchema: {
				item: z.string().describe('Item name to craft'),
				amount: z.number().int().positive().default(1)
					.describe('Amount to craft')
			}
		},
		async ({ item, amount }) =>
		{
			const res = await getMgr().craft(item, amount)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'smelt',
		{
			description: 'Smelt a specified amount of an item using a nearby furnace',
			inputSchema: {
				item: z.string().describe('Input item to smelt'),
				amount: z.number().int().positive().default(1)
					.describe('Amount to smelt')
			}
		},
		async ({ item, amount }) =>
		{
			const res = await getMgr().smelt(item, amount)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'deposit',
		{
			description: 'Deposit items into a nearby container',
			inputSchema: {
				container: z.string().default('chest')
					.describe('Container type, for example chest or barrel'),
				item: z.string().optional()
					.describe('Specific item to deposit; omit to deposit available items'),
				amount: z.number().int().positive().optional()
					.describe('Amount to deposit')
			}
		},
		async ({ container, item, amount }) =>
		{
			const res = await getMgr().deposit(
				container,
				item || null,
				amount ?? null
			)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'withdraw',
		{
			description: 'Withdraw items from a nearby container',
			inputSchema: {
				item: z.string().describe('Item name to withdraw'),
				amount: z.number().int().positive().default(1)
					.describe('Amount to withdraw'),
				container: z.string().optional()
					.describe('Container type or name, if required')
			}
		},
		async ({ item, amount, container }) =>
		{
			const res = await getMgr().withdraw(
				item,
				amount,
				container || null
			)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'set_home',
		{
			description: 'Save the bot current position as a named home location',
			inputSchema: {
				name: z.string().default('default')
					.describe('Home location name')
			}
		},
		async ({ name }) =>
		{
			const res = await getMgr().setHome(name)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'go_home',
		{
			description: 'Navigate to a saved home location',
			inputSchema: {
				name: z.string().default('default')
					.describe('Home location name')
			}
		},
		async ({ name }) =>
		{
			const res = await getMgr().goHome(name)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'delete_home',
		{
			description: 'Delete a saved home location',
			inputSchema: {
				name: z.string().describe('Home location name')
			}
		},
		async ({ name }) =>
		{
			const res = await getMgr().deleteHome(name)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'list_homes',
		{
			description: 'List all saved home locations',
			inputSchema: {}
		},
		async () =>
		{
			const res = getMgr().listHomes()

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'mark_location',
		{
			description: 'Save the bot current position as a named waypoint',
			inputSchema: {
				name: z.string().describe('Waypoint name')
			}
		},
		async ({ name }) =>
		{
			const res = await getMgr().markLocation(name)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'go_to_marker',
		{
			description: 'Navigate to a saved waypoint',
			inputSchema: {
				name: z.string().describe('Waypoint name')
			}
		},
		async ({ name }) =>
		{
			const res = await getMgr().goToMarker(name)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'delete_marker',
		{
			description: 'Delete a saved waypoint',
			inputSchema: {
				name: z.string().describe('Waypoint name')
			}
		},
		async ({ name }) =>
		{
			const res = await getMgr().deleteMarker(name)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'get_threats',
		{
			description: 'List nearby hostile entities and their distances',
			inputSchema: {
				radius: z.number().positive().default(24)
					.describe('Search radius in blocks')
			}
		},
		async ({ radius }) =>
		{
			const res = getMgr().getThreats(radius)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'attack',
		{
			description: 'Attack a visible entity or player',
			inputSchema: {
				target: z.string().describe('Visible entity name or player username')
			}
		},
		async ({ target }) =>
		{
			const res = await getMgr().attack(target)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'protect',
		{
			description: 'Follow and protect a specified player from hostile entities',
			inputSchema: {
				player: z.string().describe('Player username to protect')
			}
		},
		async ({ player }) =>
		{
			const res = await getMgr().protect(player)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'avoid',
		{
			description: 'Avoid a specified entity type for a limited duration',
			inputSchema: {
				entity: z.string().describe('Entity type to avoid'),
				duration: z.number().int().positive().default(60000)
					.describe('Avoidance duration in milliseconds')
			}
		},
		async ({ entity, duration }) =>
		{
			const res = await getMgr().avoid(entity, duration)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'pause',
		{
			description: 'Pause the current high-level task',
			inputSchema: {}
		},
		async () =>
		{
			const res = await getMgr().pause()

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'resume',
		{
			description: 'Resume the paused high-level task',
			inputSchema: {}
		},
		async () =>
		{
			const res = await getMgr().resume()

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'get_task_status',
		{
			description: 'Return the current task and action status',
			inputSchema: {}
		},
		async () =>
		{
			const res = getMgr().getTaskStatus()

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	server.registerTool(
		'run_task',
		{
			description: 'Plan and execute a multi-step survival task from a natural-language goal',
			inputSchema: {
				description: z.string()
					.min(1)
					.describe('Natural-language description of the task to perform')
			}
		},
		async ({ description }) =>
		{
			const res = await getMgr().runTask(description)

			return {
				content: [{ type: 'text', text: res.msg }]
			}
		}
	)

	return server
}

function startMcpServer(getActionManager, port = 3001)
{
	if (serverInstance) return // Prevent starting multiple listeners on reconnects

	const app = express()
	app.use(express.json())

	// Streamable HTTP endpoint for Open WebUI
	app.post('/mcp', async (req, res) =>
	{
		try
		{
			const transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: undefined // Stateless mode for per-request REST routing
			})
			const server = createServer(getActionManager)
			await server.connect(transport)
			await transport.handleRequest(req, res, req.body)
		} catch (err)
		{
			if (!res.headersSent) res.status(500).send(err.message)
		}
	})

	app.get('/mcp', (req, res) =>
	{
		res.json({ ok: true, name: 'minecraft-bot-mcp', status: 'ready' })
	})

	serverInstance = app.listen(port, '0.0.0.0', () =>
	{
		console.log(`[MCP] Streamable HTTP server listening at http://0.0.0.0:${port}/mcp`)
	})
}

module.exports = { startMcpServer }