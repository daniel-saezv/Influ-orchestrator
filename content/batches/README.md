# Lotes de contenido

Cada lote es una carpeta `LOTE-XXXX/` con `batch.json`, `guiones.md`, `media/` y opcionalmente `previews/`.

## Media en el repositorio

Para reducir redistribución de activos IA y el tamaño del repo al hacerlo público, **no** se versionan aquí vídeos de demostración reales. El lote `LOTE-0001` incluye **placeholders mínimos** (`media/*.mp4`, `previews/*.jpg`) generados con ffmpeg para pruebas locales; copias equivalentes en `tests/fixtures/lote-0001-media/`.

Sustituye esos archivos por tu producción antes de `node bot/influ.mjs submit …` en un entorno real.