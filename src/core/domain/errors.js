// Errores de dominio normalizados. `http` es solo una sugerencia para la capa HTTP.
export class DomainError extends Error {
  constructor(code, message, { http = 400, details = undefined } = {}) {
    super(message);
    this.code = code;
    this.http = http;
    this.details = details;
  }
  toJSON() { return { code: this.code, message: this.message, details: this.details }; }
}
export const err = (code, message, http, details) => new DomainError(code, message, { http, details });
