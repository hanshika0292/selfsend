import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Error names mirror the `RESEND_ERROR_CODE_KEY` union shipped in the resend SDK. */
export type ErrorName =
  | 'invalid_idempotency_key'
  | 'validation_error'
  | 'missing_api_key'
  | 'restricted_api_key'
  | 'invalid_api_key'
  | 'not_found'
  | 'method_not_allowed'
  | 'invalid_idempotent_request'
  | 'concurrent_idempotent_requests'
  | 'invalid_attachment'
  | 'invalid_from_address'
  | 'invalid_access'
  | 'invalid_parameter'
  | 'missing_required_field'
  | 'rate_limit_exceeded'
  | 'application_error'
  | 'internal_server_error';

export class ApiError extends Error {
  readonly statusCode: ContentfulStatusCode;
  readonly errorName: ErrorName;

  constructor(statusCode: ContentfulStatusCode, errorName: ErrorName, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.errorName = errorName;
  }

  toJSON() {
    return { statusCode: this.statusCode, message: this.message, name: this.errorName };
  }
}

export const notFound = (what: string) => new ApiError(404, 'not_found', `${what} not found`);
export const validation = (message: string) => new ApiError(422, 'validation_error', message);
