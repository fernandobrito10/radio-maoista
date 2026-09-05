export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'ao vivo';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function progressBar(currentMs, totalMs, size = 20) {
  if (!Number.isFinite(totalMs) || totalMs <= 0) {
    return '🔴 ao vivo';
  }
  const ratio = Math.min(1, Math.max(0, currentMs / totalMs));
  const pos = Math.min(size - 1, Math.floor(ratio * size));
  return `${'▬'.repeat(pos)}🔵${'▬'.repeat(size - pos - 1)}`;
}

export function truncate(text, max = 60) {
  const clean = String(text ?? '');
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * Escapa markdown pra titulo de musica nao virar italico/negrito no embed.
 *
 * Parenteses e colchetes entram na lista porque sem eles um titulo com
 * "](http://algo) [" fecha o link do embed e abre outro apontando pra onde quiser.
 * A barra invertida vem primeiro pra nao escapar o escape.
 */
export function escapeMd(text) {
  return String(text ?? '').replace(/([\\*_`~|[\]()])/g, '\\$1');
}

export function trackLink(track) {
  const title = escapeMd(truncate(track.title, 70));
  return track.url ? `[${title}](${track.url})` : title;
}

export function plural(n, singular, pluralForm) {
  return n === 1 ? singular : pluralForm;
}
