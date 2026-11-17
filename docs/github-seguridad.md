# GitHub: seguridad del repositorio

Recomendado **antes** de cambiar el repositorio a público:

1. **Secret scanning** y **Push protection**: *Settings → Code security and analysis* → activar *Secret scanning* y *Push protection* (disponible en repos públicos; en privados según plan).
2. **Dependabot**: ya definido en `.github/dependabot.yml` (actualizaciones semanales de Actions). Revisa y fusiona PRs de Dependabot con criterio.
3. **Branch protection** en `main`: exigir el workflow `secrets-guard` y revisiones si aplica.
4. Tras hacer el repo público, GitHub escaneará el historial; mantén `gitleaks` en CI como segunda capa.

No commitear `INFLU_*`, `.dev.vars`, `secrets.json` ni `deploy/out/secrets.js` (el workflow `secrets-guard` falla si aparecen en `git ls-files`).