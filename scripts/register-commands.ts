import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { commandJson } from '../src/discord/commands/definitions.js';

const token = process.env.DISCORD_TOKEN, appId = process.env.DISCORD_CLIENT_ID, guild = process.env.DEV_GUILD_ID;
if (!token || !appId) { console.error('DISCORD_TOKEN and DISCORD_CLIENT_ID are required'); process.exit(1); }
const rest = new REST({ version: '10' }).setToken(token);
// PUT is a bulk overwrite: idempotent, removes stale commands, safe to re-run on every deploy.
const route = guild ? Routes.applicationGuildCommands(appId, guild) : Routes.applicationCommands(appId);
const out = (await rest.put(route, { body: commandJson() })) as unknown[];
console.log(`registered ${out.length} commands ${guild ? `to guild ${guild}` : 'globally (can take up to an hour to propagate)'}`);
