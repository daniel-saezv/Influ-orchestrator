/** Cabeceras de Cloudflare Access (service token). Nunca loguear los valores. */
export function accessHeadersFromEnv(env = process.env) {
  const id = env.INFLU_CF_ACCESS_CLIENT_ID?.trim();
  const secret = env.INFLU_CF_ACCESS_CLIENT_SECRET?.trim();
  if (!id || !secret) return {};
  return {
    'CF-Access-Client-Id': id,
    'CF-Access-Client-Secret': secret,
  };
}