// PUERTO: BatchRepository — registro de lotes, versiones, publicaciones, aprobaciones y auditoría.
// Implementación POC: D1Repository (Cloudflare D1, sustituto de n8n Data Tables).
// Métodos usados por los casos de uso (ver src/adapters/repository/d1-repository.js):
//   getBatch, insertBatchVersion, updateBatchStatus, listPublications, listDispatchablePublications,
//   claimPublication, savePublicationOutcome, addApproval, invalidateApprovals, getValidApproval,
//   addEvent, audit, listEvents, useNonce, logEgress, listEgress
export const BATCH_REPOSITORY_METHODS = [
  'getBatch', 'insertBatchVersion', 'updateBatchStatus', 'listPublications', 'listDispatchableBatches',
  'claimPublication', 'savePublicationOutcome', 'addApproval', 'invalidateApprovals', 'getValidApproval',
  'addEvent', 'audit', 'listEvents', 'useNonce', 'logEgress', 'listEgress',
];
