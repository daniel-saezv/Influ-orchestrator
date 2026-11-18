# UI de encargos

Aplicación mobile-first hecha con Vite, React, Tailwind y shadcn. Consume las rutas `/v1/me/*` del Worker desde el mismo origen y se construye como asset del Worker.

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

`src/api/api.js` usa `fetch` con `credentials: "same-origin"`, envía partes de hasta 5 MiB como cuerpos binarios y calcula sus SHA-256 en el teléfono. La implementación fingida queda solo en las pruebas. El navegador no contiene HMAC, cuerpos persistidos, tokens ni secretos; `localStorage` guarda únicamente el id de una subida interrumpida.

El build `dist/` incluye el manifiesto PWA, iconos PNG y un icono para Safari. Se publica junto al Worker mediante `[assets]` en `wrangler.toml`; `/v1/*` sigue ejecutándose en el Worker. No hay service worker.
