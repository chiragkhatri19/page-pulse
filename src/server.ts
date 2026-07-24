import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadConfig, type Config } from './config.js';
import { AppError, ErrorCode, badRequest, rateLimited } from './errors.js';
import { AuditService, type AuditReport } from './lib/auditService.js';
import { MemoryCache, SingleFlight, type CacheStore } from './lib/cache.js';
import { clientKeyFrom, TokenBucketRateLimiter } from './lib/rateLimit.js';
import { createSemaphore, type Semaphore } from './lib/semaphore.js';

const AuditBodySchema = z.object({
  url: z.string().min(1, 'url is required').max(2048, 'url must be 2048 characters or fewer'),
  fresh: z.boolean().optional(),
  ttlSeconds: z.number().int().min(0).max(86_400).optional(),
});

const AuditQuerySchema = z.object({
  url: z.string().min(1).max(2048),
  fresh: z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  ttlSeconds: z.coerce.number().int().min(0).max(86_400).optional(),
});

export interface BuildOptions {
  config?: Config;
  cache?: CacheStore<AuditReport>;
  semaphore?: Semaphore;
  auditService?: AuditService;
}

export interface AppContext {
  config: Config;
  cache: CacheStore<AuditReport>;
  semaphore: Semaphore;
  limiter: TokenBucketRateLimiter;
  service: AuditService;
  startedAt: number;
}

export function buildServer(opts: BuildOptions = {}): FastifyInstance & { ctx: AppContext } {
  const config = opts.config ?? loadConfig();

  const cache = opts.cache ?? new MemoryCache<AuditReport>({ maxEntries: config.CACHE_MAX_ENTRIES });
  const semaphore =
    opts.semaphore ??
    createSemaphore({
      permits: config.MAX_CONCURRENT_AUDITS,
      maxQueueDepth: config.MAX_QUEUE_DEPTH,
      queueTimeoutMs: config.CONCURRENCY_QUEUE_TIMEOUT_MS,
    });
  const limiter = new TokenBucketRateLimiter({
    max: config.RATE_LIMIT_MAX,
    windowSeconds: config.RATE_LIMIT_WINDOW_SECONDS,
  });
  const service =
    opts.auditService ??
    new AuditService({ config, cache, semaphore, singleFlight: new SingleFlight<AuditReport>() });

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      // One JSON object per line, with a stable shape a log pipeline can index.
      base: { service: 'page-pulse', env: config.NODE_ENV },
      timestamp: () => `,"time":"${new Date().toISOString()}"`,
      redact: {
        paths: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers.cookie'],
        censor: '[redacted]',
      },
      serializers: {
        req(request) {
          return {
            method: request.method,
            url: request.url,
            remoteAddress: request.ip,
            userAgent: request.headers['user-agent'],
          };
        },
        res(reply) {
          return { statusCode: reply.statusCode };
        },
      },
    },
    // Every request carries an ID: reuse the caller's if present so a trace can
    // be stitched across services, otherwise mint one.
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      if (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128) {
        return incoming;
      }
      return randomUUID();
    },
    requestIdHeader: false,
    trustProxy: true,
    bodyLimit: 16 * 1024,
    keepAliveTimeout: 30_000,
  });

  const ctx: AppContext = { config, cache, semaphore, limiter, service, startedAt: Date.now() };
  const decorated = app as unknown as FastifyInstance & { ctx: AppContext };
  decorated.ctx = ctx;

  const sweeper = setInterval(() => limiter.sweep(), config.RATE_LIMIT_WINDOW_SECONDS * 1000);
  sweeper.unref?.();
  app.addHook('onClose', async () => clearInterval(sweeper));

  app.register(cors, { origin: true, methods: ['GET', 'POST', 'OPTIONS'] });

  // Echo the request ID on every response, including errors.
  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  // Rate limit only the expensive surface. Health checks stay free so a probe
  // can never be throttled out of existence.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/audit')) return;
    const key = clientKeyFrom(req.headers as Record<string, unknown>, req.ip);
    const decision = limiter.consume(key);
    reply.header('x-ratelimit-limit', decision.limit);
    reply.header('x-ratelimit-remaining', decision.remaining);
    reply.header('x-ratelimit-reset', decision.resetAt);
    if (!decision.allowed) {
      req.log.warn({ event: 'rate_limited', clientKey: key, requestId: req.id }, 'rate limit hit');
      reply.header('retry-after', decision.retryAfterSeconds);
      throw rateLimited(decision.retryAfterSeconds);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const requestId = String(req.id);

    if (err instanceof AppError) {
      const logLevel = err.expected ? 'warn' : 'error';
      req.log[logLevel](
        { event: 'request_failed', code: err.code, statusCode: err.statusCode, requestId },
        err.message,
      );
      if (err.retryAfterSeconds !== undefined) reply.header('retry-after', err.retryAfterSeconds);
      return reply.status(err.statusCode).type('application/json').send(err.toBody(requestId));
    }

    // Fastify's own errors (bad JSON, body too large, 404 shape) map to 4xx.
    const raw = err as Error & { statusCode?: number };
    const statusCode = raw.statusCode ?? 500;
    if (statusCode >= 400 && statusCode < 500) {
      req.log.warn({ event: 'request_rejected', statusCode, requestId }, raw.message);
      return reply.status(statusCode).type('application/json').send({
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: raw.message,
          requestId,
        },
      });
    }

    req.log.error({ event: 'unhandled_error', err: raw, requestId }, 'unhandled error');
    return reply.status(500).type('application/json').send({
      error: {
        code: ErrorCode.INTERNAL,
        message: 'An unexpected error occurred. Quote the request ID when reporting this.',
        requestId,
      },
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).type('application/json').send({
      error: {
        code: ErrorCode.NOT_FOUND,
        message: `No route for ${req.method} ${req.url}`,
        requestId: String(req.id),
      },
    });
  });

  // ---- Routes -------------------------------------------------------------

  app.get('/healthz', async () => ({ status: 'ok', uptimeSeconds: process.uptime() }));

  app.get('/readyz', async (_req, reply) => {
    // Ready means "can accept work", which is false once the queue is saturated.
    const saturated = semaphore.queueDepth >= config.MAX_QUEUE_DEPTH;
    if (saturated) {
      return reply.status(503).send({ status: 'saturated', queueDepth: semaphore.queueDepth });
    }
    return { status: 'ready', inFlight: semaphore.inFlight, queueDepth: semaphore.queueDepth };
  });

  app.get('/v1/stats', async () => ({
    uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000),
    cache: { ...cache.stats(), entries: cache.size(), ttlSeconds: config.CACHE_TTL_SECONDS },
    concurrency: {
      limit: config.MAX_CONCURRENT_AUDITS,
      inFlight: semaphore.inFlight,
      queueDepth: semaphore.queueDepth,
    },
    rateLimit: {
      max: config.RATE_LIMIT_MAX,
      windowSeconds: config.RATE_LIMIT_WINDOW_SECONDS,
      trackedClients: limiter.size,
    },
    memory: { rssBytes: process.memoryUsage().rss },
  }));

  const handleAudit = async (
    input: { url: string; fresh?: boolean; ttlSeconds?: number },
    req: { id: unknown; log: { info: (o: object, m: string) => void } },
    reply: { header: (k: string, v: string | number) => unknown },
  ) => {
    const outcome = await ctx.service.audit({
      url: input.url,
      ...(input.fresh !== undefined ? { fresh: input.fresh } : {}),
      ...(input.ttlSeconds !== undefined ? { ttlSeconds: input.ttlSeconds } : {}),
    });

    reply.header('x-cache', outcome.cache.hit ? 'HIT' : 'MISS');
    reply.header('x-cache-age', outcome.cache.ageSeconds);
    reply.header('cache-control', `public, max-age=${outcome.cache.ttlSeconds}`);

    req.log.info(
      {
        event: 'audit_completed',
        requestId: req.id,
        target: outcome.report.finalUrl,
        cacheHit: outcome.cache.hit,
        deduped: outcome.cache.deduped,
        score: outcome.report.score.overall,
        targetStatus: outcome.report.http.status,
        durationMs: outcome.durationMs,
      },
      'audit completed',
    );

    return {
      requestId: String(req.id),
      cache: outcome.cache,
      durationMs: outcome.durationMs,
      report: outcome.report,
    };
  };

  app.post('/v1/audit', async (req, reply) => {
    const parsed = AuditBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest('Request body failed validation', formatIssues(parsed.error));
    }
    return handleAudit(parsed.data, req, reply);
  });

  app.get('/v1/audit', async (req, reply) => {
    const parsed = AuditQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      throw badRequest('Query string failed validation', formatIssues(parsed.error));
    }
    return handleAudit(parsed.data, req, reply);
  });

  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  app.register(staticPlugin, { root: publicDir, prefix: '/', index: ['index.html'] });

  return decorated;
}

function formatIssues(error: z.ZodError): { field: string; message: string }[] {
  return error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));
}
