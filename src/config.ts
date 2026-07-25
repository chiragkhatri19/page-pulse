import { z } from 'zod';

/**
 * All runtime tuning lives here. Every knob is environment-driven so the same
 * artifact can be promoted from dev to prod without a rebuild.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Hard ceiling on how long we will hold a client connection for one audit. */
  AUDIT_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8_000),
  /** Timeout for the first byte from the target origin. */
  FETCH_HEADERS_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
  /** Bytes of HTML we are willing to download and parse. Protects memory. */
  MAX_RESPONSE_BYTES: z.coerce.number().int().min(1024).default(3_000_000),
  /** Redirect hops we will follow before giving up. */
  MAX_REDIRECTS: z.coerce.number().int().min(0).max(20).default(5),

  /** Global in-flight outbound audit cap. Back-pressure, not queueing. */
  MAX_CONCURRENT_AUDITS: z.coerce.number().int().min(1).default(25),
  /** How long a request may wait for a concurrency slot before we shed it. */
  CONCURRENCY_QUEUE_TIMEOUT_MS: z.coerce.number().int().min(0).default(2_000),
  /** Max requests parked waiting for a slot. Beyond this we fail fast. */
  MAX_QUEUE_DEPTH: z.coerce.number().int().min(0).default(200),
  /** Per-host in-flight cap. 0 derives a conservative cap from the global limit. */
  MAX_CONCURRENT_AUDITS_PER_HOST: z.coerce.number().int().min(0).default(0),
  /** Consecutive target failures before a hostname's circuit opens. */
  HOST_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(5),
  /** How long an unhealthy hostname is shed before we try it again. */
  HOST_CIRCUIT_COOLDOWN_MS: z.coerce.number().int().min(1000).default(60_000),

  /** Configurable cache window. 0 disables caching entirely. */
  CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(300),
  CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).default(1_000),

  /** Token-bucket rate limit, per client key. */
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(30),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),

  /** SSRF guard. Disable ONLY in tests that audit a loopback fixture server. */
  ALLOW_PRIVATE_TARGETS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  USER_AGENT: z.string().default('PagePulse/1.0 (+https://github.com/chiragkhatri19/page-pulse)'),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${detail}`);
  }
  return parsed.data;
}
