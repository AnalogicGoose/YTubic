# CI: `build-linux` falló en el release v0.4.1

Estado: **resuelto por reintento** (2026-07-13). El run y el release están completos.

## Resolución confirmada

El mismo run se volvió a ejecutar y terminó correctamente. El job Linux compiló y
subió `Goosic_0.4.1_amd64.AppImage`, `.deb`, `.rpm`, sus firmas y un `latest.json`
con las plataformas Linux. El primer `Error: other side closed` fue transitorio;
no hubo un fallo reproducible de compilación, memoria ni empaquetado en el reintento.

Esto solo resuelve la publicación. El AppImage v0.4.1 todavía contiene el problema
de runtime descrito en `docs/linux-appimage-black-screen.md`.

## Historial del fallo inicial

- Run: https://github.com/AnalogicGoose/Goosic/actions/runs/29284769657 (tag `v0.4.1`).
- `build-windows`: éxito. `build-linux`: **falló** en el paso `tauri-apps/tauri-action@v0`.
- Durante el fallo inicial, el release v0.4.1 solo tenía el instalador Windows. El
  reintento añadió después todos los artefactos Linux.
- Error reportado por el usuario en la consola de GitHub Actions: `Error: other side closed`.
- El entorno ya tiene autenticación de `gh` y se verificaron tanto el reintento como
  los assets públicos del release.

## Hipótesis históricas (ya no requieren cambios)

"Error: other side closed" en el paso de `tauri-action` para Linux suele ser un pipe roto
porque el proceso hijo (el build de Rust/tauri) murió a mitad de camino. Candidatos, de
más a menos probable:

1. **Blip de red al descargar `linuxdeploy`/`appimagetool`** durante el empaquetado del
   AppImage — esas herramientas se descargan en el momento del build (no vienen
   pre-instaladas en el runner ni están vendorizadas en el repo), así que un timeout/reset
   de red ahí produce justo este tipo de error.
2. **El runner se quedó sin memoria** al compilar Rust (con las dependencias nuevas del
   soporte Linux: `aes-gcm`, `keyring`, etc.) y empaquetar los 3 formatos (`appimage`,
   `deb`, `rpm`) en la misma tanda — `ubuntu-latest` tiene recursos limitados (2 vCPU,
   ~7GB RAM en el runner gratuito de GitHub).
3. Algo específico introducido en el commit de v0.4.1 (`ef4bff1`, el fix del
   DMABUF renderer) — parece poco probable, es un cambio trivial de 10 líneas en
   `main.rs` sin nuevas dependencias, pero no descartado sin ver el log real.

## Siguiente paso

No cambiar el CI por este incidente aislado. El siguiente release debe validar que el
AppImage incluye los plugins GStreamer requeridos y probar el fix de runtime descrito en
`docs/linux-appimage-black-screen.md`.
