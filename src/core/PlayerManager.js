import { GuildQueue } from './GuildQueue.js';
import { log } from '../utils/logger.js';

/** Uma fila por servidor. */
class PlayerManager {
  /** @type {Map<string, GuildQueue>} */
  #queues = new Map();

  get(guildId) {
    return this.#queues.get(guildId) ?? null;
  }

  has(guildId) {
    return this.#queues.has(guildId);
  }

  /** Devolve a fila existente ou cria (e conecta) uma nova. */
  async ensure({ guild, voiceChannel, textChannel }) {
    const existing = this.#queues.get(guild.id);
    if (existing && !existing.destroyed) {
      existing.textChannel = textChannel ?? existing.textChannel;
      await existing.connect(voiceChannel);
      return existing;
    }

    const queue = new GuildQueue({
      guild,
      voiceChannel,
      textChannel,
      onDestroy: (q) => {
        if (this.#queues.get(guild.id) === q) this.#queues.delete(guild.id);
        log.debug(`Fila destruida em ${guild.name}`);
      },
    });

    this.#queues.set(guild.id, queue);
    try {
      await queue.connect(voiceChannel);
    } catch (err) {
      queue.destroy();
      throw err;
    }
    return queue;
  }

  destroyAll() {
    for (const queue of [...this.#queues.values()]) queue.destroy();
    this.#queues.clear();
  }

  get size() {
    return this.#queues.size;
  }
}

export const manager = new PlayerManager();
