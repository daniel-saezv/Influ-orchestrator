# UI de encargos

Aplicación mobile-first hecha con Vite, React, Tailwind y shadcn. Identidad «camerino»: crema y espresso, azafrán y el punto rojo de REC; Fraunces para titulares y Schibsted Grotesk para el texto; modo claro, oscuro o del sistema.

Flujo: pestañas Estudio, Historial y Tú. En Estudio se elige cuenta, idea o archivos y plataformas; «Preparar» lleva a la espera y después a la previa. En la previa, deslizar a la derecha aprueba y a la izquierda pide cambios; aprobar y programar es un solo paso. Consume las rutas `/v1/me/*` del Worker desde el mismo origen y se construye como asset del Worker.

## Instalar y arrancar

```bash
cd ui
npm ci
npm run dev
```

Vite muestra la URL local. Las llamadas `/v1/*` necesitan el Worker desplegado o Access; para validar el contrato sin backend se siguen usando `tests` y `fakeApi.js`.

## Validar

```bash
npm run lint
npm run test:run
npm run build
```

`src/api/api.js` usa `fetch` con `credentials: "same-origin"`, envía partes de hasta 5 MiB como cuerpos binarios y calcula sus SHA-256 en el teléfono. La implementación fingida queda solo en las pruebas. El navegador no contiene HMAC, cuerpos persistidos, tokens ni secretos; `localStorage` guarda únicamente el id de una subida interrumpida (`influ-upload-session`) y la preferencia de tema (`influ-theme`).

El build `dist/` incluye el manifiesto PWA, iconos PNG y un icono para Safari. Se publica junto al Worker mediante `[assets]` en `wrangler.toml`; `/v1/*` sigue ejecutándose en el Worker. No hay service worker.
