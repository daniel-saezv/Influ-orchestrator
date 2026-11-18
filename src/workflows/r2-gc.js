// Borrado de objetos de R2. Si DeleteObject falla, la fila y los bytes se quedan
// y el cron lo reintenta. Los huérfanos (sesión abierta más de un día) salen de D1.
import { ORPHAN_AFTER_MS } from '../core/domain/r2-quota.js';

export async function deleteAssetObjects(repo, r2, rows, userId) {
  const gone = [];
  const failed = [];
  for (const row of rows) {
    try {
      if (!r2) throw new Error('R2 binding missing');
      await r2.delete(row.r2_key);
      gone.push(row);
    } catch {
      failed.push(row);
    }
  }
  const bytes = gone.reduce((sum, row) => sum + Number(row.size_bytes), 0);
  await repo.settleAssetDeletes({ gone, failed, userId, bytes });
  return { bytes, failed: failed.length };
}

export async function retryPendingDeletes(ctx, limit = 5) {
  const rows = await ctx.repo.listPendingDeletes(limit);
  for (const row of rows) {
    await deleteAssetObjects(ctx.repo, ctx.r2, [row], row.user_id);
  }
  return rows.length;
}

export async function deleteOrphanUploads(ctx, limit = 5) {
  const cutoff = new Date(Date.parse(ctx.now()) - ORPHAN_AFTER_MS).toISOString();
  const sessions = await ctx.repo.listOrphanUploads(cutoff, limit);
  for (const session of sessions) {
    const parts = JSON.parse(session.part_hashes_json || '{}');
    let failed = false;
    for (const info of Object.values(parts)) {
      try {
        if (!ctx.r2) throw new Error('R2 binding missing');
        await ctx.r2.delete(info.key);
      } catch {
        failed = true;
      }
    }
    if (failed) continue;
    await ctx.repo.dropOrphanUpload(session);
  }
  return sessions.length;
}

export async function releaseEncargoObjects(ctx, batchId) {
  const encargo = await ctx.repo.encargoByBatch(batchId);
  if (!encargo) return { bytes: 0, failed: 0 };
  const rows = await ctx.repo.listAssets(encargo.encargo_id);
  return deleteAssetObjects(ctx.repo, ctx.r2, rows, encargo.user_id);
}
