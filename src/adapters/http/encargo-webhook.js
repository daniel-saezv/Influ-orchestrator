// Aviso a la rutina de Grok Bot al quedar un encargo en cola.
// La URL y la clave son secretos del Worker. Sin URL, o sin clave, no se llama a nada.
import { allowEgressHost } from './egress-guard.js';

let transportForTests = null;

/** Solo pruebas. En producción el envío usa fetch, que pasa por la guardia de salida. */
export function setEncargoWebhookTransport(fn) {
  transportForTests = fn ?? null;
}

function webhookTarget(env) {
  const urlRaw = String(env?.INFLU_WEBHOOK_URL ?? '').trim();
  const secret = String(env?.INFLU_WEBHOOK_SECRET ?? '');
  if (!urlRaw || !secret) return { ok: false, reason: 'absent' };
  let target;
  try { target = new URL(urlRaw); } catch { return { ok: false, reason: 'invalid' }; }
  if (target.protocol !== 'https:' || target.username || target.password || target.port) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, target, secret };
}

export async function notifyEncargoQueued(env, encargo) {
  const ready = webhookTarget(env);
  if (!ready.ok) return { sent: false, reason: ready.reason };
  const body = JSON.stringify({
    event: 'encargo.queued',
    encargo_id: encargo.encargo_id,
    kind: encargo.kind,
    status: encargo.status,
  });
  allowEgressHost(ready.target.hostname);
  const send = transportForTests ?? globalThis.fetch;
  try {
    const res = await send(ready.target.toString(), {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ready.secret}`,
      },
      body,
    });
    if (res.status < 200 || res.status >= 300) return { sent: false, reason: 'http', status: res.status };
    return { sent: true };
  } catch {
    return { sent: false, reason: 'error' };
  }
}
