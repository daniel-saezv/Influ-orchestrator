# UI de encargos

Aplicación mobile-first de la fase B, hecha con Vite, React, Tailwind y shadcn. Consume una API fingida sustituible por el cliente del Worker en la fase G.

## Instalar y arrancar

```bash
cd ui
npm ci
npm run dev
```

Vite muestra la URL local. No hay que arrancar Wrangler: `wrangler dev --local` no soporta actualmente el export `SERVICE_VERSION`.

## Validar

```bash
npm run lint
npm run test:run
npm run build
```

La API de `src/api/` simula todas las rutas `/v1/me`, conserva el aislamiento entre cuentas y solo guarda en `localStorage` el id de una subida interrumpida. El navegador no contiene HMAC ni secretos. Cualquier cliente real futuro debe usar `credentials: "same-origin"`.

La PWA aún no tiene service worker ni está conectada al Worker. El texto de «Añadir a pantalla de inicio» se limita a preparar la experiencia cuando `display-mode` no sea `standalone`.
