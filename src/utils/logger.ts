type LogLevel = 'info' | 'warn' | 'error';

export function maskPhone(phone: string | undefined): string {
  if (!phone) return 'xxxx';
  const digits = phone.replace(/\D/g, '');
  return digits.slice(-4) || 'xxxx';
}

function emit(level: LogLevel, event: string, details?: Record<string, unknown>, phone?: string): void {
  const entry: Record<string, unknown> = {
    level,
    ts: new Date().toISOString(),
    event,
  };
  if (phone) entry.phone_last4 = maskPhone(phone);
  if (details) entry.details = details;
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (event: string, details?: Record<string, unknown>, phone?: string) => emit('info', event, details, phone),
  warn: (event: string, details?: Record<string, unknown>, phone?: string) => emit('warn', event, details, phone),
  error: (event: string, details?: Record<string, unknown>, phone?: string) => emit('error', event, details, phone),
};
