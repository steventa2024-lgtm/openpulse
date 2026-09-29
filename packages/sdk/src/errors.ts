/** Error codes the gateway returns, plus the ones the SDK raises itself. */
export type OpenPulseErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAIRING_REQUIRED'
  | 'UNAVAILABLE'
  | 'INTERNAL'
  | 'TIMEOUT'
  | 'CLOSED'
  | 'CONNECT_FAILED'
  | 'RUN_FAILED'
  | (string & {});

/**
 * Every failure the SDK surfaces — from the gateway or from the connection — is an OpenPulseError,
 * so callers can branch on `code` instead of parsing messages.
 */
export class OpenPulseError extends Error {
  constructor(
    readonly code: OpenPulseErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'OpenPulseError';
  }

  /** True for errors worth retrying after reconnecting. */
  get retryable(): boolean {
    return (
      this.code === 'CLOSED' ||
      this.code === 'TIMEOUT' ||
      this.code === 'CONNECT_FAILED' ||
      this.code === 'UNAVAILABLE'
    );
  }
}
