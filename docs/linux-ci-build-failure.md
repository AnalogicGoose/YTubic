# CI: `build-linux` falló en el release v0.4.1

Estado: **sin diagnosticar a fondo** (2026-07-13) — falta acceso autenticado a los logs.

## Qué se sabe

- Run: https://github.com/AnalogicGoose/Goosic/actions/runs/29284769657 (tag `v0.4.1`).
- `build-windows`: éxito. `build-linux`: **falló** en el paso `tauri-apps/tauri-action@v0`.
- Consecuencia: el release v0.4.1 solo publicó `Goosic_0.4.1_x64-setup.exe` (+`.sig`) y
  `latest.json` con únicamente la plataforma `windows-x86_64` — **no hay AppImage/deb/rpm
  de v0.4.1**. Los usuarios Linux siguen en v0.4.0 (que sí tiene todos los formatos, ver
  release v0.4.0).
- Error reportado por el usuario en la consola de GitHub Actions: `Error: other side closed`.
- **No se pudo leer el log completo del job**: `GET /repos/.../actions/jobs/{id}/logs`
  devuelve 403 sin autenticación, y este entorno no tiene un token de GitHub configurado
  (solo hay una deploy key SSH, que sirve para git push/pull, no para la API REST). Falta
  un fine-grained PAT con permiso `Actions: Read-only` en el repo, o `gh auth login`, para
  poder leer el log exacto en vez de especular.

## Hipótesis (sin confirmar)

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

1. **Conseguir acceso de lectura a los logs** — fine-grained PAT (`Actions: Read-only`,
   solo este repo) o `gh auth login`, para bajar el log real de
   `https://github.com/AnalogicGoose/Goosic/actions/runs/29284769657/job/86936901543` y
   confirmar cuál de las 3 hipótesis es la correcta.
2. Si es la hipótesis 1 (red transitoria): probablemente basta con re-lanzar el job
   ("Re-run failed jobs" en la UI de Actions) — no requiere cambios de código.
3. Si es la hipótesis 2 (memoria): separar el build de Linux en 3 jobs (uno por bundle
   target: appimage / deb / rpm) en vez de uno solo construyendo los 3, o usar un runner
   con más recursos.
4. Una vez resuelto, hay que **volver a publicar los artefactos Linux para v0.4.1**
   (o directamente saltar a v0.4.2 con el fix del CI + lo que salga de
   `docs/linux-appimage-black-screen.md`) — mientras tanto los usuarios Linux no tienen
   forma de recibir el fix del DMABUF renderer vía auto-update.
