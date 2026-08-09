/** Error that carries an HTTP status so handlers can respond correctly. */
export class AppError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
