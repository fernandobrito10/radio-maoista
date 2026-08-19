import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../utils/logger.js';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');
const dataFile = path.join(dataDir, 'users.json');

/**
 * Persistencia simples em JSON: { [discordUserId]: { lastfm: { name, sessionKey, scrobbling } } }
 * Escrita atomica (tmp + rename) e serializada, pra nao corromper com writes concorrentes.
 */
class UserStore {
  #cache = null;
  #writeChain = Promise.resolve();

  async #load() {
    if (this.#cache) return this.#cache;
    try {
      const raw = await readFile(dataFile, 'utf8');
      this.#cache = JSON.parse(raw);
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn('Falha lendo users.json, comecando vazio:', err.message);
      this.#cache = {};
    }
    return this.#cache;
  }

  #flush() {
    const snapshot = JSON.stringify(this.#cache, null, 2);
    this.#writeChain = this.#writeChain.then(async () => {
      await mkdir(dataDir, { recursive: true });
      const tmp = `${dataFile}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, dataFile);
    }).catch((err) => log.error('Falha salvando users.json:', err));
    return this.#writeChain;
  }

  async getLastfm(userId) {
    const data = await this.#load();
    return data[userId]?.lastfm ?? null;
  }

  async setLastfm(userId, { name, sessionKey, scrobbling = true }) {
    const data = await this.#load();
    data[userId] = { ...data[userId], lastfm: { name, sessionKey, scrobbling } };
    await this.#flush();
  }

  async setScrobbling(userId, enabled) {
    const data = await this.#load();
    if (!data[userId]?.lastfm) return false;
    data[userId].lastfm.scrobbling = Boolean(enabled);
    await this.#flush();
    return true;
  }

  async unlinkLastfm(userId) {
    const data = await this.#load();
    if (!data[userId]?.lastfm) return false;
    delete data[userId].lastfm;
    if (Object.keys(data[userId]).length === 0) delete data[userId];
    await this.#flush();
    return true;
  }
}

export const userStore = new UserStore();
