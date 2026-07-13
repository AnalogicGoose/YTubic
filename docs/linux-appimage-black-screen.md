# Linux AppImage: se congela y se pone en negro al interactuar

Estado: **causa identificada y fix aplicado, pendiente de validar en el próximo AppImage**
(2026-07-13).

## Causa confirmada

El patrón exacto de stderr no es solo un problema del renderer:

```text
GStreamer element appsink not found. Please install it.
GStreamer element autoaudiosink not found. Please install it
GLib-GObject-CRITICAL: invalid (NULL) pointer instance
g_signal_connect_data: assertion 'G_TYPE_CHECK_INSTANCE (instance)' failed
```

Tauri documenta ese mismo fallo para AppImages multimedia sin el framework GStreamer
completo. `appsink` viene de los plugins base y `autoaudiosink` de los plugins good. El
AppImage aislaba `GST_PLUGIN_SYSTEM_PATH_1_0` hacia su propio directorio, pero Goosic no
tenía activado `bundle.linux.appimage.bundleMediaFramework`; por eso no podía usar los
plugins instalados en el host y el `WebKitWebProcess` terminaba muriendo.

El fix hace dos cosas:

1. Activa `bundle.linux.appimage.bundleMediaFramework` en `tauri.conf.json`.
2. Instala `gstreamer1.0-plugins-base`, `good`, `bad` y `libav` en el runner Ubuntu antes
   de empaquetar. El workflow comprueba tanto los elementos del host como
   `libgstapp.so`, `libgstautodetect.so` y `libgstlibav.so` dentro del AppImage final.

El workaround DMABUF permanece como defensa para GPUs/compositores problemáticos, pero
no era suficiente para este crash del AppImage.

## Síntoma reportado

- Build afectado: `Goosic_0.4.0_amd64.AppImage` (release v0.4.0 — la única build de Linux
  publicada hasta ahora; v0.4.1 nunca generó artefactos Linux, ver
  `docs/linux-ci-build-failure.md`).
- La app abre y carga la UI normalmente.
- Al interactuar (reportado como "elijo una canción" / deja de responder a input), dejar
  de responder — no procesa más clicks/teclado.
- La ventana termina poniéndose completamente negra.
- Máquina de prueba del usuario: Linux (mismo perfil que el entorno de desarrollo de este
  repo — CachyOS/Arch, KDE Plasma, **Wayland**).

## Hipótesis inicial del renderer (defensa conservada)

WebKitGTK tiene un bug conocido con su renderer DMABUF en varios compositores Wayland:
cuelga/pinta en negro en el primer paint pesado de GPU. Ya lo habíamos pisado en
`pnpm tauri dev` (`Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display`),
resuelto ahí con `WEBKIT_DISABLE_DMABUF_RENDERER=1` en el entorno. Ese workaround nunca
había entrado al binario empaquetado.

**Fix ya aplicado en `main`** (commit `ef4bff1`, incluido en v0.4.1 fuente — pero el
artefacto Linux de v0.4.1 nunca se publicó porque el job `build-linux` falló en CI, ver
el otro doc): `src-tauri/src/main.rs` ahora hace, antes de que arranque GTK/WebKit:

```rust
#[cfg(target_os = "linux")]
if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
}
```

La prueba posterior demostró que este workaround no bastaba: el AppImage fuerza X11 y,
además, le faltaban plugins GStreamer. Se conserva porque sigue protegiendo otros casos
conocidos de WebKitGTK/Wayland, pero ya no se considera la solución principal.

## Plan de repro local

1. Compilar el AppImage en el entorno de desarrollo (mismo Linux/Wayland que el usuario)
   desde el `main` actual, que ya incluye el fix DMABUF:
   ```bash
   pnpm tauri build --bundles appimage
   ```
2. Correr el AppImage resultante directamente (no `pnpm tauri dev` — necesitamos el
   binario release empaquetado tal cual lo tendría un usuario final).
3. Reproducir el flujo: abrir la app, esperar a que cargue, elegir/reproducir una canción,
   ver si se congela y se pone en negro.
4. Capturar stdout/stderr completos del proceso (los mensajes de GTK/WebKit/Wayland salen
   por ahí, no hay ventana de logs en la UI).

## Resultado de la prueba (2026-07-13, hecha en este mismo entorno de dev — CachyOS/KDE/Wayland)

Se compiló el AppImage localmente desde `main` (commit `3c693e6`, ya con el fix DMABUF) y se
corrió directo (no vía `pnpm tauri dev`). **Hallazgo central: el fix DMABUF probablemente no
tiene ninguna chance de aplicarse, porque el AppImage nunca corre sobre Wayland nativo.**

### El AppImage fuerza X11/XWayland, no Wayland nativo

`linuxdeploy-plugin-gtk.sh` — el script que `tauri-action`/`tauri build` descarga y ejecuta
automáticamente al empaquetar el AppImage (queda embebido en
`Goosic.AppDir/apprun-hooks/linuxdeploy-plugin-gtk.sh`, se corre desde `AppRun` en cada
arranque) — tiene esta línea:

```bash
export GDK_BACKEND=x11 # Crash with Wayland backend on Wayland - We tested it without it and ended up with this: https://github.com/tauri-apps/tauri/issues/8541
```

Es decir: **todo AppImage de Tauri para Linux fuerza el backend X11 (vía XWayland) por
defecto**, citando un issue de Tauri de 2024 sobre crashes en Wayland nativo. Esto es upstream
del proyecto (viene de `linuxdeploy-plugin-gtk`, no de nuestro código) y nadie lo había tocado.

Confirmado en el proceso corriendo de verdad:

```
$ cat /proc/<pid-de-goosic>/environ | tr '\0' '\n' | grep -E "GDK_BACKEND|WAYLAND_DISPLAY"
WAYLAND_DISPLAY=wayland-0
GDK_BACKEND=x11
```

Y confirmado que la ventana es un cliente XWayland real (no Wayland nativo) vía `xprop`:

```
$ xprop -root _NET_CLIENT_LIST
_NET_CLIENT_LIST(WINDOW): window id # 0x100000b, 0x3000003
$ xprop -id 0x3000003 _NET_WM_NAME _NET_WM_PID WM_CLASS
_NET_WM_NAME(UTF8_STRING) = "Goosic"
_NET_WM_PID(CARDINAL) = <pid>
WM_CLASS(STRING) = "goosic", "Goosic"
```

(una ventana Wayland nativa no aparecería en absoluto en `_NET_CLIENT_LIST`, que es una
propiedad puramente X11 — solo XWayland la expone ahí).

**Consecuencia:** nuestro fix (`WEBKIT_DISABLE_DMABUF_RENDERER=1`) apunta al renderer DMABUF de
Wayland nativo. Si el AppImage siempre corre bajo XWayland, ese fix probablemente no tiene
ningún efecto ahí — el bug original de v0.4.0 pudo haber sido, desde el principio, un problema
de XWayland (no de Wayland nativo), y el freeze/negro que sigue ocurriendo con el build nuevo
(con el fix ya aplicado) lo confirma.

### Crash reproducible del WebKitWebProcess ~20s después de arrancar

En **cada** corrida local (2 de 2), pasados ~20s del arranque, aparece esto en stderr y el
`WebKitWebProcess` muere y se respawnea con un PID nuevo (confirmado con `ps`, el proceso
`WebKitWebProcess` cambia de PID mientras el proceso principal `goosic` sigue el mismo):

```
(WebKitWebProcess:<pid>): GLib-GObject-CRITICAL **: <hora>: invalid (NULL) pointer instance

(WebKitWebProcess:<pid>): GLib-GObject-CRITICAL **: <hora>: g_signal_connect_data: assertion 'G_TYPE_CHECK_INSTANCE (instance)' failed
```

Justo después de esto, en la segunda corrida, la ventana — aunque seguía registrada como
`WM_STATE: Normal` / mapeada / en el desktop 0 según `xprop` — **dejó de aparecer por completo**
en una captura de pantalla completa (`spectacle`), es decir: no solo se pone negra, en algún
punto el compositor deja de recibir contenido pintado de ella del todo. Esto es coherente con
"se congela y no responde" — probablemente el WebProcess respawneado nunca vuelve a quedar
correctamente enlazado a la superficie/ventana X11 original.

También aparecen, en cada arranque (probablemente sin relación, no confirmado):

```
GStreamer element appsink not found. Please install it.
GStreamer element autoaudiosink not found. Please install it
```

Estas líneas no eran ruido: coinciden exactamente con los reportes upstream de AppImages
Tauri cuyo WebKit queda sin los plugins multimedia requeridos. Son la señal que llevó al
fix de `bundleMediaFramework` descrito al inicio de este documento.

### Descartado: no es un artefacto de cómo se lanzó la prueba

La primera corrida se lanzó desde un proceso en background (`setsid`, sin terminal interactiva,
sin "activation token" de escritorio) — no como haría un usuario real. Para descartar que eso
fuera la causa, se dejó que `AppImageLauncher` (instalado en este sistema) integrara y lanzara
el mismo AppImage **de forma nativa** (doble-click real, ícono en `~/Applications/`, proceso
lanzado por el propio `AppImageLauncher`, no por este script). Resultado: **el mismo patrón** —
`WebKitWebProcess` se respawnea, y la ventana (con procesos vivos, uno de los WebKitWebProcess
al 86% CPU) desaparece por completo de una captura de pantalla completa. Se reproduce igual sin
importar cómo se lance. No es un artefacto de la prueba — es un bug real de la app empaquetada.

## Validación pendiente

1. Crear el siguiente AppImage en GitHub Actions; el workflow debe pasar sus comprobaciones
   de plugins empaquetados.
2. Ejecutarlo en CachyOS/KDE/Wayland, esperar más de un minuto y reproducir varias canciones.
3. Confirmar que ya no aparecen los avisos `appsink`/`autoaudiosink`, que el
   `WebKitWebProcess` conserva su PID y que la ventana sigue respondiendo.
4. Solo si el AppImage con GStreamer completo todavía falla, retomar las pruebas de backend
   Wayland/XWayland o `WEBKIT_DISABLE_COMPOSITING_MODE=1`; desactivar toda la aceleración
   continúa siendo el último recurso por su impacto de rendimiento.

## Nota aparte: compilar el AppImage localmente en este dev machine (CachyOS/Arch) falla sin un workaround

Ver `docs/linux-appimage-local-build-workaround.md` — el `strip` que trae empaquetado
`linuxdeploy` (la herramienta de bundling) es demasiado viejo para entender las relocations
`.relr.dyn` que genera el toolchain de un Arch/CachyOS actual, y el build de `tauri build
--bundles appimage` falla 100% de las veces en este tipo de sistema sin aplicar el workaround
documentado ahí. No parece afectar al runner de CI (Ubuntu, toolchain más viejo) — son dos
problemas distintos, ver `docs/linux-ci-build-failure.md`.
