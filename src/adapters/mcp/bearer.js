// Comparación del bearer del MCP. El secreto vive solo en el Worker.
// HMAC de ambos valores: la comparación no depende de la longitud ni se corta al primer byte distinto.

const HMAC_KEY = new TextEncoder().encode('influ-mcp-bearer-v1');

async function mac(value) {
  const key = await crypto.subtle.importKey('raw', HMAC_KEY, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

export async function bearerMatches(presented, secret) {
  if (typeof presented !== 'string' || typeof secret !== 'string') return false;
  if (presented.length < 16 || presented.length > 256) return false;
  if (secret.length < 16 || secret.length > 256) return false;
  const a = await mac(presented);
  const b = await mac(secret);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function mcpBearerOk(request, secret) {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (\S+)$/i.exec(header);
  if (!match) return false;
  return bearerMatches(match[1], typeof secret === 'string' ? secret : '');
}
