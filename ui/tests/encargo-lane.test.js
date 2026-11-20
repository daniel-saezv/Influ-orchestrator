import { describe, expect, it } from 'vitest'
import { encargoLane, readyArrivals } from '../src/lib/encargo-lane.js'

const NOW = Date.parse('2026-11-19T12:00:00.000Z')

describe('encargo lanes', () => {
  it('maps backend statuses onto the five filters', () => {
    expect(encargoLane({ status: 'draft' }, NOW)).toBe('en_curso')
    expect(encargoLane({ status: 'queued' }, NOW)).toBe('en_curso')
    expect(encargoLane({ status: 'claimed' }, NOW)).toBe('en_curso')
    expect(encargoLane({ status: 'preparing' }, NOW)).toBe('en_curso')
    expect(encargoLane({ status: 'failed' }, NOW)).toBe('en_curso')
    expect(encargoLane({ status: 'ready' }, NOW)).toBe('listo')
    expect(encargoLane({ status: 'approved' }, NOW)).toBe('listo')
    expect(encargoLane({ status: 'cancelled' }, NOW)).toBe('cancelado')
    expect(encargoLane({ status: 'scheduled', publish_at: '2026-11-20T09:00:00.000Z' }, NOW)).toBe('programado')
    expect(encargoLane({ status: 'scheduled', publish_at: '2026-11-19T12:00:30.000Z' }, NOW)).toBe('publicado')
    expect(encargoLane({ status: 'scheduled', publish_at: '2026-11-18T12:00:00.000Z' }, NOW)).toBe('publicado')
    expect(encargoLane({ status: 'scheduled' }, NOW)).toBe('publicado')
  })

  it('only reports a ready result that was already on the list', () => {
    const previous = [{ id: 'a', status: 'queued' }, { id: 'b', status: 'ready' }]
    const next = [{ id: 'a', status: 'ready' }, { id: 'b', status: 'ready' }, { id: 'c', status: 'ready' }]
    expect(readyArrivals(null, next)).toEqual([])
    expect(readyArrivals(previous, next).map((item) => item.id)).toEqual(['a'])
  })
})
