// Selección de modo y proveedor. Diseño "fail-closed":
//  - Valor por defecto: MOCK.
//  - PUBLISHER_MODE ausente, vacío o "mock" => mock.
//  - Cualquier otro valor exige configuración LIVE completa + confirmación de seguridad;
//    si falta algo => error de configuración y NO se publica (nunca se cae en LIVE por accidente).
//  - En esta build LIVE está deshabilitado en código (LIVE_ENABLED_IN_BUILD = false):
//    ninguna variable de entorno ni petición HTTP puede activarlo.
import { err } from './domain/errors.js';

export const LIVE_ENABLED_IN_BUILD = false;
export const SUPPORTED_PROVIDERS = ['youtube', 'instagram', 'tiktok'];

export function resolvePublisherConfig(env = {}) {
  const rawMode = env.PUBLISHER_MODE;
  const mode = rawMode === undefined || rawMode === null || String(rawMode).trim() === '' ? 'mock' : String(rawMode).trim();
  const provider = (env.PUBLISHER_PROVIDER ?? 'youtube').trim();
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw err('MODE_CONFIG_INVALID', `PUBLISHER_PROVIDER no soportado: ${provider}`, 500);
  }
  if (mode === 'mock') return { mode: 'mock', provider, live: false };
  if (mode !== 'live') throw err('MODE_CONFIG_INVALID', `PUBLISHER_MODE inválido: "${mode}". Valores permitidos: mock | live`, 500);
  // Petición de LIVE: requiere TODAS las comprobaciones. En esta POC siempre falla.
  const problems = [];
  if (!LIVE_ENABLED_IN_BUILD) problems.push('LIVE deshabilitado en esta build (LIVE_ENABLED_IN_BUILD=false)');
  if (env.LIVE_SAFETY_ACK !== `ENABLE_LIVE_PUBLISHING_${provider.toUpperCase()}`) problems.push('Falta LIVE_SAFETY_ACK con la frase de confirmación exacta');
  if (env.DEPLOY_ENV !== 'production') problems.push('DEPLOY_ENV debe ser "production"');
  throw err('LIVE_MODE_BLOCKED', 'Se solicitó PUBLISHER_MODE=live pero no se cumplen las comprobaciones de seguridad. No se publicará nada.', 500, problems);
}

export function runtimeSettings(env = {}) {
  const int = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : d);
  return {
    maxAttempts: Math.min(int(env.MAX_ATTEMPTS, 3), 5),
    retryBaseSeconds: int(env.RETRY_BASE_SECONDS, 10),
    maxPublicationsPerRun: Math.min(int(env.MAX_PUBLICATIONS_PER_RUN, 4), 6),
    maxStatusPolls: Math.min(int(env.MAX_STATUS_POLLS, 3), 5),
    signatureWindowSeconds: int(env.SIGNATURE_WINDOW_SECONDS, 300),
  };
}
