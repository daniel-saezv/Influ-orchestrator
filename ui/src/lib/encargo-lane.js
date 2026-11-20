export const LANES = [
  { id: 'todos', label: 'Todos' },
  { id: 'en_curso', label: 'En curso' },
  { id: 'listo', label: 'Listo' },
  { id: 'programado', label: 'Programado' },
  { id: 'publicado', label: 'Publicado' },
  { id: 'cancelado', label: 'Cancelado' },
]

export const SCHEDULE_GRACE_MS = 60_000

const IN_PROGRESS = new Set(['draft', 'queued', 'claimed', 'preparing', 'failed'])
const READY = new Set(['ready', 'approved'])

export function encargoLane(item, now = Date.now()) {
  const status = item?.status
  if (status === 'cancelled') return 'cancelado'
  if (status === 'scheduled') {
    const at = Date.parse(item.publish_at ?? '')
    if (Number.isFinite(at) && at > now + SCHEDULE_GRACE_MS) return 'programado'
    return 'publicado'
  }
  if (READY.has(status)) return 'listo'
  if (IN_PROGRESS.has(status)) return 'en_curso'
  return 'en_curso'
}

export function readyArrivals(previous, next) {
  if (!Array.isArray(previous) || !Array.isArray(next)) return []
  const before = new Map(previous.map((item) => [item.id, item.status]))
  return next.filter((item) => item?.status === 'ready' && before.has(item.id) && before.get(item.id) !== 'ready')
}
