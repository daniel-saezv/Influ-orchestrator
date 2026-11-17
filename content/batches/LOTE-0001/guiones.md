# LOTE-0001 — Producción creativa (Grok Bot, director creativo)

**Personaje:** Lúa, creadora virtual (IA) de Madrid. Estilo de vida urbano, trucos prácticos y calma. Melena corta lila plateada, pecas, collar fino de plata. Tono cercano, frases cortas, tuteo.

**Estrategia de la semana 47:** 3 Shorts verticales (9:16) de utilidad rápida en tres franjas distintas (tarde, mañana, noche) para medir qué horario funciona mejor. Todos declaran contenido sintético (`containsSyntheticMedia`).

| # | Concepto | Gancho (0–2 s) | Guion (8–30 s) | CTA | Fecha prevista (hora de Madrid) |
|---|---|---|---|---|---|
| 1 | Fotos nocturnas con el móvil | "¿Tus fotos de noche salen movidas?" | Azotea al anochecer. 1) Apoya el móvil y temporizador 3 s. 2) Baja la exposición. 3) Limpia la lente. | "¿Cuál pruebas hoy?" | 19 nov 2026, 18:00 |
| 2 | Rutina de mañana | "Mi mañana en 30 segundos" | Café junto a la ventana, cuaderno, 10 min sin pantallas, plan de 3 tareas. | "¿Cómo empiezas tú el día?" | 20 nov 2026, 08:30 |
| 3 | Escritorio minimalista | "5 claves, sin comprar nada" | Superficie despejada, luz cálida, una planta, cables ocultos, solo lo diario. | "Guárdalo para tu próximo orden" | 21 nov 2026, 19:00 |

## Prompts de imagen usados (generador de imágenes de Grok Bot)

1. *P01:* Retrato vertical fotorrealista de Lúa en una azotea de Madrid a la hora azul, luces de la ciudad desenfocadas, sostiene el móvil para hacer una foto nocturna; tonos teal y naranja; sin texto ni logos.
2. *P02 (con P01 como referencia de personaje):* Lúa en una cafetería de Madrid por la mañana, junto a la ventana con un café y un cuaderno, camisa de lino verde salvia; luz dorada.
3. *P03 (con P01 como referencia):* Lúa en un escritorio minimalista de roble claro con portátil, planta y lámpara cálida, señalando el escritorio; sudadera gris carbón.

## Montaje

`ffmpeg`: imagen → 8 s a 30 fps, 720x1280, zoom lento (Ken Burns), rótulo inferior con el gancho, aviso superior "IA · contenido sintético · LOTE-0001", pista de audio silenciosa. Sin voz ni música en esta fase (pendiente: TTS/música con licencia).

Las imágenes originales están en `previews/`; los vídeos finales en `media/`.
