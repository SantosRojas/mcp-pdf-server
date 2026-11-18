export class AppError extends Error {
  readonly code: string;
  readonly path?: string;
  readonly details?: unknown;

  constructor(message: string, code = 'INTERNAL_ERROR', path?: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (path !== undefined) this.path = path;
    if (details !== undefined) this.details = details;
  }
}

export function errorPayload(error: unknown): Record<string, unknown> {
  if (error && typeof error === 'object' && Array.isArray((error as { issues?: unknown }).issues)) {
    const issues = (error as { issues: Array<{ path?: unknown[]; message?: string; code?: string }> }).issues;
    return {
      code: 'VALIDATION_ERROR',
      message: 'El contenido no cumple el esquema esperado.',
      details: issues.map((issue) => ({ path: (issue.path ?? []).map(String).join('.'), message: issue.message ?? 'Valor inválido.', ...(issue.code ? { code: issue.code } : {}) }))
    };
  }
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, ...(error.path ? { path: error.path } : {}), ...(error.details ? { details: error.details } : {}) };
  }
  if (error instanceof Error) return { code: 'INTERNAL_ERROR', message: error.message };
  return { code: 'INTERNAL_ERROR', message: String(error) };
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
