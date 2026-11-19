// Revisión de respaldo: una vez por día UTC, en el cron que ya existe.
// Solo deja constancia si hay encargos en cola sin reclamar. No reclama, no avisa y no publica.

export async function reviewUnclaimedQueue(repo, nowIso) {
  const day = String(nowIso).slice(0, 10);
  const last = await repo.lastBackupReviewDay();
  if (last === day) return { skipped: true, queued: 0 };
  const encargos = await repo.listQueuedEncargos();
  await repo.audit('cron', 'ENCARGO_BACKUP_CHECKED', null, { day, queued: encargos.length }, nowIso);
  if (encargos.length) {
    console.info(JSON.stringify({
      event: 'encargo_backup_review',
      day,
      queued: encargos.length,
      encargo_ids: encargos.map((row) => row.encargo_id),
    }));
  }
  return { skipped: false, queued: encargos.length };
}
