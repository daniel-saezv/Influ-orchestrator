// Guardia de salida: intercepta fetch() global. En modo MOCK no se permite NINGUNA llamada
// saliente; cualquier intento se bloquea y queda registrado (prueba TEST 13).
// Los bindings de Cloudflare (D1, KV) no usan fetch() global y no se ven afectados.
const attempts = [];
const extraAllowedHosts = new Set();
let installed = false;

export function allowEgressHost(hostname) {
  if (hostname) extraAllowedHosts.add(hostname);
}

export function installEgressGuard(getAllowedHosts) {
  if (installed) return;
  installed = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const allowed = getAllowedHosts().includes(url.hostname) || extraAllowedHosts.has(url.hostname);
    attempts.push({ at: new Date().toISOString(), host: url.hostname, url: url.origin + url.pathname, allowed });
    if (!allowed) throw new Error(`EGRESS_BLOCKED: salida a ${url.hostname} bloqueada por la guardia (modo MOCK)`);
    return realFetch(input, init);
  };
}

export function drainEgressAttempts() { return attempts.splice(0, attempts.length); }
