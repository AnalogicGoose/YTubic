# Compilar el AppImage localmente en Arch/CachyOS falla sin workaround

Estado: **workaround encontrado y funciona**, no aplicado a ningún script todavía — manual
cada vez. Relevante solo para compilar/probar el AppImage en este dev machine (o cualquier
Arch/CachyOS/distro rolling-release similar); no parece afectar al runner de CI de GitHub
Actions (`ubuntu-latest`, toolchain más viejo — ver `docs/linux-ci-build-failure.md`, que es
un problema aparte).

## Síntoma

`pnpm tauri build --bundles appimage` compila Rust sin problema, pero falla siempre en el paso
de empaquetado:

```
failed to bundle project `failed to run linuxdeploy`
Error failed to bundle project `failed to run linuxdeploy`
ELIFECYCLE  Command failed with exit code 1.
```

Tauri (`tauri-bundler`) traga el error real — solo muestra ese mensaje genérico
(`crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs`, usa `cmd.output()` y descarta
stdout/stderr salvo para el status code).

## Causa real (encontrada corriendo `linuxdeploy` a mano)

El binario `strip` que trae empaquetado `linuxdeploy-x86_64.AppImage` (descargado por
tauri-bundler a `~/.cache/tauri/linuxdeploy-x86_64.AppImage`) es demasiado viejo para entender
las secciones `.relr.dyn` (relocations RELR, un formato compacto que el toolchain de
Arch/CachyOS ya genera por defecto en sus librerías del sistema). Falla así en **cada** librería
que intenta stripear:

```
Calling strip on library ./Goosic.AppDir/usr/lib/libwebkit2gtk-4.1.so.0
ERROR: Strip call failed: .../usr/bin/strip: ./Goosic.AppDir/usr/lib/libwebkit2gtk-4.1.so.0: unknown type [0x13] section `.relr.dyn'
.../usr/bin/strip: Unable to recognise the format of the input file `...'
```

Esto SÍ es fatal (exit code 1, ningún AppImage se genera) — no es solo un warning.

## Workaround que funcionó

Reemplazar el `strip` viejo empaquetado dentro de `linuxdeploy` por el `strip` del sistema
(que sí entiende `.relr.dyn`, porque es el mismo toolchain que generó esas libs):

```bash
# 1. Extraer linuxdeploy una vez a un directorio persistente (no el temp que usa tauri-bundler)
mkdir -p /tmp/linuxdeploy-extracted && cd /tmp/linuxdeploy-extracted
~/.cache/tauri/linuxdeploy-x86_64.AppImage --appimage-extract

# 2. Reemplazar su strip viejo por un symlink al del sistema
rm squashfs-root/usr/bin/strip
ln -s /usr/bin/strip squashfs-root/usr/bin/strip

# 3. Compilar Rust + generar el AppDir normalmente (esto sí funciona con tauri build,
#    falla recién en el paso de empaquetado — dejar que llegue hasta ahí y falle,
#    el AppDir queda armado en target/release/bundle/appimage/Goosic.AppDir)
pnpm tauri build --bundles appimage   # falla al final, es esperado

# 4. Correr linuxdeploy a mano desde la extracción parcheada, con el AppDir que sí se armó,
#    apuntando el PATH a donde tauri-bundler dejó los plugins descargados (~/.cache/tauri)
cd src-tauri/target/release/bundle/appimage
OUTPUT="$(pwd)/Goosic_<version>_amd64.AppImage" \
ARCH=x86_64 \
PATH="$HOME/.cache/tauri:$PATH" \
/tmp/linuxdeploy-extracted/squashfs-root/AppRun --verbosity 1 --appdir ./Goosic.AppDir --plugin gtk --output appimage
```

Con esto el `.AppImage` se genera bien (probado, arrancó y corrió — ver
`docs/linux-appimage-black-screen.md` para lo que se encontró al correrlo).

## Por qué no se aplicó como fix permanente

Es un problema del **entorno de build** (Arch/CachyOS con RELR por defecto + `linuxdeploy`
desactualizado), no del código de Goosic — no hay nada que arreglar en el repo por esto. Vale
la pena, eso sí, si en el futuro se quiere compilar/probar el AppImage seguido en esta máquina,
automatizarlo en algún script de dev (`scripts/`) en vez de repetir los 4 pasos a mano cada vez.

## Nota

`AppImageLauncher` (si está instalado en el sistema, como en este caso) intercepta la ejecución
directa de un `.AppImage` y muestra un diálogo de integración antes de arrancar la app de
verdad — molesto para pruebas rápidas por script. Se evita extrayendo una vez
(`./Goosic_x.y.z_amd64.AppImage --appimage-extract`, genera `squashfs-root/`) y corriendo
`./squashfs-root/AppRun` directo, que no pasa por el hook de `binfmt_misc` que usa
AppImageLauncher para interceptar.
