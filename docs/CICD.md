# Despliegue automático (CI/CD)

Cada `git push` a `main` se prueba solo en GitHub y, si pasa, se instala solo en
la PC del POS. No hace falta armar zip ni ir hasta la PC.

```
push a main ──► GitHub Actions: pruebas con simulador ──► rama "produccion"
                                                            │
PC del POS (cada 2 min) ◄──────────────────────────────────┘
  ¿commit nuevo? ¿caja libre? → frena, respalda la base, baja el código,
  npm ci si cambiaron dependencias, arranca, verifica.
  Si no levanta → vuelve sola a la versión anterior.
```

## Cómo funciona

**Pruebas (`.github/workflows/ci.yml`).** En cada push corren `test-humo`,
`test-grupos`, `test-estaciones`, `test-deploy` y `test-ui` (con Chromium), con la
balanza en simulador, base vacía y sin Google Sheets. Solo si todo pasa, un
segundo paso mueve la rama `produccion` a ese commit. Un push a otra rama o un
pull request solo corre las pruebas. Si fallan, en Actions quedan las capturas
de pantalla para ver qué pasó.

**Actualizador (`instalador/actualizar.ps1`).** Lo corre la tarea programada
`BalanzaPOS-Actualizar` cada 2 minutos como SYSTEM. Sigue la rama `produccion`
(no `main`): a la PC solo llega lo que pasó las pruebas.

- **Espera caja libre.** Consulta `GET /api/deploy/ocupado` (solo responde desde
  la propia PC). Está ocupada si algún equipo tiene artículos en el carrito o si
  hubo uso en los últimos 60 s (toques en pantalla o escrituras a la API). Si
  está ocupada, reintenta en el próximo ciclo. El carrito vive en el navegador:
  cada equipo le informa al servidor cuántos artículos tiene por WebSocket.
- **Respaldo** con `VACUUM INTO` en `respaldos\pos-<fecha>-antes-de-<commit>.db`
  (quedan los últimos 15). Si no se puede respaldar, no despliega.
- **`npm ci`** solo si cambió `package.json` o `package-lock.json`. Como corre
  con el POS frenado, no choca con los `.node` bloqueados por Windows.
- **Verificación**: espera hasta 30 s a que `/api/version` responda con el commit
  nuevo y 10 s más a que siga vivo.
- **Vuelta atrás automática** si no levanta: código, dependencias y base (la
  del respaldo está al día porque mientras no respondía no se pudo vender). Ese
  commit queda marcado como fallido y no se reintenta hasta que llegue otro.

**Pantallas.** El servidor manda su versión por WebSocket. La pantalla de venta
se recarga sola cuando cambia, pero solo con el carrito vacío y sin toques en
los últimos 20 s. Administración no se recarga sola (puede haber un formulario
a medio llenar): muestra "Se instaló una versión nueva del POS" con un botón, y
arriba a la derecha la versión instalada y el estado del actualizador.

## Qué no viaja por git

Cada PC tiene lo suyo, fuera del repositorio (`.gitignore`):

| Archivo | Qué es |
|---|---|
| `config.json` | Balanzas, estaciones, venta, Sheets. Si falta, se crea desde `config.example.json`. |
| `data\` | La base SQLite. |
| `logs\`, `respaldos\` | Logs del POS y del actualizador; respaldos de la base. |
| `deploy.json` | Config del actualizador (repo, rama, espera, `habilitado`). |
| `.deploy\` | Clave de despliegue (solo SYSTEM y Administradores). |
| `runtime\` | Node 22 portable con npm. |
| `version.json` | Versión instalada (la escribe el actualizador). |
| `config.gs`, `.env*` | Secretos de Apps Script y de otros proyectos. Hay un `config.gs.example` sin claves. |

## Puesta en marcha (una sola vez)

### 1. Subir el código (PC de desarrollo)

Crear en GitHub un repositorio **privado y vacío** (sin README), por ejemplo
`balanza-pos`. En la carpeta del proyecto, con Git for Windows instalado:

```
git init -b main
git add .
git status
```

Revisar que en la lista **no** aparezcan `config.json`, `config.gs`,
`.env.example.*` ni `data/`. Después:

```
git commit -m "POS con despliegue automatico"
git remote add origin https://github.com/USUARIO/balanza-pos.git
git push -u origin main
```

En la pestaña **Actions** del repositorio aparece la corrida "CI/CD" (tarda unos
3 minutos). Cuando termina en verde, existe la rama `produccion`.

### 2. Preparar la PC del POS

Copiar `instalador\ci-instalar.bat` y `instalador\ci-instalar.ps1` a la PC del
POS (pendrive, o bajarlos de GitHub) y hacer doble clic en `ci-instalar.bat`.
Pide administrador y el repositorio (`USUARIO/balanza-pos`).

1. Instala Git si falta (winget).
2. Baja Node 22 portable (con npm) a `C:\BalanzaPOS\runtime`.
3. Crea una **clave de despliegue** y la deja copiada. Cargarla en GitHub →
   repositorio → Settings → Deploy keys → *Add deploy key*, **sin** tildar
   "Allow write access". Volver a la ventana y apretar Enter.
4. Convierte `C:\BalanzaPOS` en un clon del repositorio. No toca `data\`,
   `config.json` ni `logs\`; respalda la base antes y aparta lo del zip viejo en
   `_paquete_anterior\` (se puede borrar cuando todo ande).
5. `npm ci`, registra las tareas `BalanzaPOS` y `BalanzaPOS-Actualizar`,
   firewall y accesos directos, y arranca.

La conexión con GitHub es por SSH en el puerto 443 (`ssh.github.com`), así que
pasa aunque la red bloquee el 22. Es seguro volver a correr `ci-instalar.bat`.

## Día a día

```
git add .
git commit -m "Que cambie"
git push
```

A los ~3 minutos pasan las pruebas y en los 2 minutos siguientes (con la caja
libre) queda instalado. La primera pantalla que se toque ya muestra la versión
nueva.

| Necesito… | Cómo |
|---|---|
| Ver qué pasó | `C:\BalanzaPOS\logs\deploy.log`, o Administración (arriba a la derecha). |
| Instalar ya, aunque estén vendiendo | `C:\BalanzaPOS\instalador\actualizar-ahora.bat` (también reintenta un commit que falló). |
| Volver a una versión anterior | `git revert <commit>` y `git push`: pasa por las pruebas como cualquier cambio. |
| Pausar las actualizaciones | En `deploy.json` poner `"habilitado": false`. |
| Probar sin publicar | Push a otra rama: corren las pruebas, no se instala. |

## Si algo falla

- **Actions en rojo**: la PC no se entera; sigue con la versión anterior. Abrir
  la corrida para ver qué prueba falló (y el artefacto "capturas" si fue la
  pantalla).
- **El paso "publicar" falla con permiso denegado**: GitHub → Settings →
  Actions → General → Workflow permissions → *Read and write permissions*.
- **`deploy.log` dice "No se pudo consultar el repositorio"**: sin internet o
  la clave de despliegue fue borrada en GitHub. Se reintenta solo.
- **"esperando que se libere la caja" todo el tiempo**: algún equipo tiene un
  carrito con artículos. Cerrar o vaciar esa venta, o usar `actualizar-ahora.bat`.
- **"falló (se volvió a la anterior)"**: el log trae las últimas líneas de
  `logs\pos.log` con el error. Corregir y hacer push de nuevo.

## Archivos

    .github/workflows/ci.yml       pruebas + publicación en la rama produccion
    instalador/actualizar.ps1      actualizador (tarea BalanzaPOS-Actualizar)
    instalador/comun.ps1           funciones compartidas con gestion.ps1
    instalador/ci-instalar.bat/.ps1  puesta en marcha en la PC del POS
    instalador/actualizar-ahora.bat  despliegue manual
    scripts/test-deploy.js         prueba de /api/version y /api/deploy/ocupado
    config.example.json            config por defecto de una PC nueva

El zip de `empaquetar.bat` sigue sirviendo para una PC sin internet.

## Configuración común (`config.comun.json`)

`config.json` es de cada PC y no está en git, así que el despliegue automático
**no lo cambia**. Lo que tiene que ser igual en todas las PC del POS va en
`config.comun.json`, que sí se versiona: al arrancar, el servidor lo mezcla sobre
`config.json` y lo que define ahí manda (en consola/log aparece
`config.comun.json: <clave> actualizado`). Las claves con `_` son comentarios.

Hoy lleva solo `sheets.url` (la URL `/exec` del proyecto de Apps Script
"POS → Planilla"). **No poner claves**: `sheets.token` sigue solo en el
`config.json` de cada PC. Para cambiar la URL: editar `config.comun.json`, commit y
push a `main`; cuando pasen las pruebas, la PC del POS la toma en el próximo
despliegue y manda sola las ventas que hayan quedado pendientes.
