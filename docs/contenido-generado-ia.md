# Contenido generado con IA

Los lotes de ejemplo (`content/batches/`) pueden incluir vídeos e imágenes **sintéticas**. En despliegues anteriores parte del material llevaba metadatos **C2PA** que indican herramientas como **Grok Imagine** (contenido algorítmico según vocabulario IPTC).

## Qué implica al publicar el repositorio

- El **código** y la documentación del proyecto van bajo [LICENSE](../LICENSE) (MIT por defecto).
- Los **activos multimedia** del lote no son software: conservan los términos del generador con el que se crearon. Este repo mantiene solo **placeholders mínimos** (vídeos de prueba generados localmente con ffmpeg) para no redistribuir assets IA de demostración en Git.
- Las copias en `batch.json` / `guiones.md` declaran `contains_synthetic_media` cuando aplica.

Para contenido real de producción, genera los archivos fuera del repositorio o en almacenamiento privado y súbelos al orquestador con la API firmada.