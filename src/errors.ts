/**
 * A closed set of error codes. Clients branch on `error.code`, never on the
 * human-readable message, so messages can be reworded without breaking callers.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  URL_NOT_ALLOWED: 'URL_NOT_ALLOWED',
  TARGET_UNREACHABLE: 'TARGET_UNREACHABLE',
  TARGET_TIMEOUT: 'TARGET_TIMEOUT',
  TARGET_TOO_LARGE: 'TARGET_TOO_LARGE',
  UNSUPPORTED_CONTENT_TYPE: 'UNSUPPORTED_CONTENT_TYPE',
  RATE_LIMITED: 'RATE_LIMITED',
  CAPACITY_EXCEEDED: 'CAPACITY_EXCEEDED',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorBody {
  error: {
    code: ErrorCodeValue;
    message: string;
    details?: unknown;
    requestId: string;
    retryAfterSeconds?: number;
  };
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCodeValue;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;
  /** True when the condition is expected traffic shaping, not a defect. */
  readonly expected: boolean;

  constructor(opts: {
    statusCode: number;
    code: ErrorCodeValue;
    message: string;
    details?: unknown;
    retryAfterSeconds?: number;
    expected?: boolean;
  }) {
    super(opts.message);
    this.name = 'AppError';
    this.statusCode = opts.statusCode;
    this.code = opts.code;
    this.details = opts.details;
    this.retryAfterSeconds = opts.retryAfterSeconds;
    this.expected = opts.expected ?? opts.statusCode < 500;
    Error.captureStackTrace?.(this, AppError);
  }

  toBody(requestId: string): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
        requestId,
        ...(this.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: this.retryAfterSeconds }
          : {}),
      },
    };
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError({ statusCode: 400, code: ErrorCode.VALIDATION_FAILED, message, details });

export const urlNotAllowed = (message: string) =>
  new AppError({ statusCode: 422, code: ErrorCode.URL_NOT_ALLOWED, message });

export const rateLimited = (retryAfterSeconds: number) =>
  new AppError({
    statusCode: 429,
    code: ErrorCode.RATE_LIMITED,
    message: 'Rate limit exceeded. Slow down and retry after the indicated delay.',
    retryAfterSeconds,
  });

export const capacityExceeded = () =>
  new AppError({
    statusCode: 503,
    code: ErrorCode.CAPACITY_EXCEEDED,
    message: 'Server is at capacity. Retry shortly.',
    retryAfterSeconds: 2,
  });
