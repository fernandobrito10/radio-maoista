import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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
  #loading = null;
  #writeChain = Promise.resolve();

  async #load() {
    if (this.#cache) return this.#cache;
    // Sem deduplicar, duas chamadas concorrentes no primeiro uso liam o arquivo
    // duas vezes e a segunda sobrescrevia a mutacao que a primeira ja fizera.
    this.#loading ??= (async () => {
      try {
        const raw = await readFile(dataFile, 'utf8');
        this.#cache = JSON.parse(raw);
      } catch (err) {
        if (err.code !== 'ENOENT') log.warn('Falha lendo users.json, comecando vazio:', err.message);
        this.#cache = {};
      }
      await this.#cleanOrphanTmp();
      return this.#cache;
    })().finally(() => { this.#loading = null; });

    return this.#loading;
  }

  /** Um SIGKILL entre o writeFile e o rename deixa um .tmp com todas as chaves. */
  async #cleanOrphanTmp() {
    try {
      const files = await readdir(dataDir);
      await Promise.all(files
        .filter((f) => f.startsWith('users.json.') && f.endsWith('.tmp'))
        .map((f) => rm(path.join(dataDir, f), { force: true })));
    } catch {
      // pasta pode nem existir ainda
    }
  }

  /**
   * Escrita atomica e serializada. A falha PRECISA chegar em quem chamou: antes,
   * o catch ficava dentro da cadeia devolvida, entao o /lastfm link respondia
   * "conectado" mesmo quando o disco recusou — e a session key sumia no restart.
   * O caso real e o bind mount ./data pertencendo a outro uid que nao o do container.
   *
   * Modo 0600/0700 porque isto guarda session key de Last.fm, que nao expira.
   */
  #flush() {
    const snapshot = JSON.stringify(this.#cache, null, 2);
    this.#writeChain = this.#writeChain
      .catch(() => {})
      .then(async () => {
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        const tmp = `${dataFile}.${process.pid}.tmp`;
        await writeFile(tmp, snapshot, { encoding: 'utf8', mode: 0o600 });
        await rename(tmp, dataFile);
      });
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
