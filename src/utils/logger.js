const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = levels[(process.env.LOG_LEVEL ?? 'info').toLowerCase()] ?? levels.info;

function emit(level, args) {
  if (levels[level] < threshold) return;
  const stamp = new Date().toISOString();
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[${stamp}] [${level.toUpperCase()}]`, ...args);
}

export const log = {
  debug: (...args) => emit('debug', args),
  info: (...args) => emit('info', args),
  warn: (...args) => emit('warn', args),
  error: (...args) => emit('error', args),
};
