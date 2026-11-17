// Estados comunes del sistema (independientes de cualquier red social).

export const PublicationStatus = Object.freeze({
  DRAFT: 'DRAFT',
  VALIDATED: 'VALIDATED',
  READY: 'READY',
  SCHEDULED: 'SCHEDULED',
  PUBLISHING: 'PUBLISHING',
  PUBLISHED: 'PUBLISHED',
  FAILED: 'FAILED',
  RETRY_PENDING: 'RETRY_PENDING',
  CANCELLED: 'CANCELLED',
});

export const BatchStatus = Object.freeze({
  DRAFT: 'DRAFT',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED',
  PUBLISHING: 'PUBLISHING',
  COMPLETED: 'COMPLETED',
  PARTIALLY_COMPLETED: 'PARTIALLY_COMPLETED',
  FAILED: 'FAILED',
});

export const Decision = Object.freeze({
  APPROVE: 'APPROVE',
  REJECT: 'REJECT',
  REQUEST_CHANGES: 'REQUEST_CHANGES',
});

// Estados de lote desde los que se acepta una nueva versión del contenido.
export const BATCH_EDITABLE = new Set([
  BatchStatus.DRAFT, BatchStatus.READY_FOR_REVIEW, BatchStatus.APPROVED,
  BatchStatus.REJECTED, BatchStatus.CHANGES_REQUESTED,
]);

// Estados de lote en los que el despachador puede trabajar.
export const BATCH_DISPATCHABLE = new Set([BatchStatus.APPROVED, BatchStatus.PUBLISHING]);

// Estados de publicación que el despachador puede reclamar.
export const PUB_CLAIMABLE = [PublicationStatus.READY, PublicationStatus.SCHEDULED, PublicationStatus.RETRY_PENDING];

export const PUB_TERMINAL = new Set([PublicationStatus.PUBLISHED, PublicationStatus.FAILED, PublicationStatus.CANCELLED]);

// Calcula el estado agregado del lote a partir de sus publicaciones activas.
export function aggregateBatchStatus(pubStatuses) {
  const s = pubStatuses.filter((x) => x !== PublicationStatus.CANCELLED);
  if (s.length === 0) return BatchStatus.FAILED;
  if (!s.every((x) => PUB_TERMINAL.has(x))) return BatchStatus.PUBLISHING;
  const ok = s.filter((x) => x === PublicationStatus.PUBLISHED).length;
  if (ok === s.length) return BatchStatus.COMPLETED;
  if (ok === 0) return BatchStatus.FAILED;
  return BatchStatus.PARTIALLY_COMPLETED;
}
