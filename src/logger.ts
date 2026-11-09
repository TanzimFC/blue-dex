import pino from 'pino';
/** Structured JSON logs. Secrets are redacted if they ever end up in a logged object. */
export const makeLogger = (level: string) =>
  pino({ level, redact: { paths: ['token', 'DISCORD_TOKEN', '*.token', '*.DISCORD_TOKEN', 'headers.authorization'], censor: '[redacted]' } });
export type Logger = ReturnType<typeof makeLogger>;
