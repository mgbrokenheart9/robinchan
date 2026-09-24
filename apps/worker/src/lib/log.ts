type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? 'info') as Level;
  return ORDER[raw] ?? ORDER.info;
}

function emit(level: Level, scope: string, message: string): void {
  if (ORDER[level] < threshold()) return;
  const stamp = new Date().toISOString().slice(11, 19);
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} ${scope.padEnd(9)} ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (scope: string, message: string) => emit('debug', scope, message),
  info: (scope: string, message: string) => emit('info', scope, message),
  warn: (scope: string, message: string) => emit('warn', scope, message),
  error: (scope: string, message: string) => emit('error', scope, message),
};
