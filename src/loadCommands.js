import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { log } from './utils/logger.js';

const commandsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'commands');

/** Carrega todo src/commands/*.js e devolve [{ name, data, execute }]. */
export async function loadCommands() {
  const files = (await readdir(commandsDir)).filter((f) => f.endsWith('.js'));
  const commands = [];

  for (const file of files) {
    const mod = await import(pathToFileURL(path.join(commandsDir, file)).href);
    if (!mod.data || typeof mod.execute !== 'function') {
      log.warn(`Ignorando ${file}: precisa exportar "data" e "execute".`);
      continue;
    }
    commands.push({ name: mod.data.name, data: mod.data, execute: mod.execute });
  }

  commands.sort((a, b) => a.name.localeCompare(b.name));
  return commands;
}
