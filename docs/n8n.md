# n8n (plantillas)

`n8n/workflows/WF-01_RECEIVE_BATCH.json`, `WF-02_APPROVE_BATCH.json`, `WF-03_SCHEDULE_AND_DISPATCH.json`, `WF-04_PUBLISHER_AND_ERROR_HANDLER.json` (generadas con `node n8n/build-workflows.mjs`).

- Importar en n8n → Workflows → Import from file. **No probadas dentro de n8n** (no hay instancia autorizada).
- Lo verificado: el código de los nodos «Firmar petición» se ejecutó en Node contra el Worker desplegado (`node n8n/verify-sign-nodes.mjs`): WF-04 y WF-03 → 200; WF-02 con huella falsa → 409 `HASH_MISMATCH` (firma aceptada, decisión rechazada).
- Configurar en n8n: Variables `INFLU_BASE_URL`, `INFLU_BOT_HMAC_SECRET`, `INFLU_APPROVER_HMAC_SECRET` (o credenciales equivalentes); credencial Header Auth para cada Webhook. Los nodos Code usan `require('crypto')` (en n8n autoalojado: `NODE_FUNCTION_ALLOW_BUILTIN=crypto`).
- Si n8n pasa a ser el motor periódico, desactivar el Cron del Worker para no duplicar ejecuciones (de todas formas el reclamo atómico evita publicar dos veces).
