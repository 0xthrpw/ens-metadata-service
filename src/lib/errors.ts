export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export const notFound = (msg: string, cause?: unknown) =>
  new HttpError(404, msg, "not_found", { cause });
export const badRequest = (msg: string, cause?: unknown) =>
  new HttpError(400, msg, "bad_request", { cause });
export const upstream = (msg: string, cause?: unknown) =>
  new HttpError(502, msg, "upstream_error", { cause });
export const unsupported = (msg: string, cause?: unknown) =>
  new HttpError(415, msg, "unsupported", { cause });
