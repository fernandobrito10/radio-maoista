import { REST, Routes } from 'discord.js';
import { assertDiscordConfig, config } from './config.js';
import { loadCommands } from './loadCommands.js';
import { log } from './utils/logger.js';

try {
  assertDiscordConfig();
} catch (err) {
  log.error(err.message);
  process.exit(1);
}

const commands = await loadCommands();
const body = commands.map((c) => c.data.toJSON());
const rest = new REST().setToken(config.discord.token);

const scope = config.discord.guildId
  ? Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId)
  : Routes.applicationCommands(config.discord.clientId);

try {
  const data = await rest.put(scope, { body });
  const where = config.discord.guildId ? `no servidor ${config.discord.guildId}` : 'globalmente';
  log.info(`Registrei ${data.length} comando(s) ${where}: ${data.map((c) => `/${c.name}`).join(', ')}`);
  if (!config.discord.guildId) {
    log.info('Comandos globais podem levar alguns minutos pra aparecer. Pra testes, defina DISCORD_GUILD_ID.');
  }
} catch (err) {
  log.error('Falha registrando os comandos:', err);
  process.exitCode = 1;
}
