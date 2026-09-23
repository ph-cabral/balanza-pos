# Balanza POS

Punto de venta para fiambrería: la balanza manda el peso por puerto serie, la tablet
muestra los productos, y al tocar uno se calcula el precio y se agrega al carrito.
El lector de código de barras suma los artículos que se venden por unidad.

Un solo proceso Node sirve la API, el WebSocket del peso y la interfaz. No hay build,
no hay motor de base de datos aparte, no hay framework de frontend. Está pensado para
correr en una PC modesta.

---

## Instalación en la PC

Hace falta Node.js 18 o superior (recomendado el instalador LTS de 64 bits de
nodejs.org). Después, en una consola parada en esta carpeta:

```
npm install
npm run seed      (opcional: carga productos de ejemplo para probar)
npm start
```

La consola muestra las direcciones. En la misma PC: `http://localhost:3000`.
Desde la tablet: la dirección `http://192.168.x.x:3000` que aparece en pantalla.

Si `npm install` falla al compilar `better-sqlite3` o `serialport`, casi siempre es
porque Node es de 32 bits o es una versión muy vieja. Instalando el LTS de 64 bits se
resuelve.

---

## Primer arranque, sin balanza

Viene configurado en **modo simulador**: la app funciona completa sin hardware.
En la pantalla de venta aparecen los botones `250 g`, `500 g` y `Tara` para simular
pesos y probar todo el circuito.

---

## Cuando llegue el cable

1. Conectá la balanza a la PC y fijate qué puerto COM le asignó Windows
   (Administrador de dispositivos → Puertos COM y LPT).

2. Con algo apoyado en la balanza, corré el diagnóstico:

   ```
   npm run ports              lista los puertos disponibles
   npm run detect             prueba el puerto de config.json a varias velocidades
   node scripts/detect-scale.js COM4        prueba ese puerto
   node scripts/detect-scale.js COM4 9600   ese puerto y esa velocidad
   ```

   El script muestra las tramas crudas que manda la balanza (en texto y en
   hexadecimal) y cuál de los parsers las entiende. Si encuentra una velocidad que
   funciona, te la dice.

3. Con ese dato, entrá a **Administración → Balanza**, destildá el simulador, elegí
   el puerto y la velocidad, y guardá. Reconecta solo, sin reiniciar nada.

Si llegan datos pero ningún parser los entiende, esas líneas de texto y hexadecimal
son todo lo que hace falta para escribir el parser exacto del modelo. Se agrega en
`src/scale/parsers.js` y listo.

Si no llega nada, revisá que la balanza tenga habilitada la salida serie en su menú
(muchas vienen apagada), que esté en modo de transmisión continua, y probá con un
cable cruzado (null-modem) si el directo no da señal.

---

## Cargar los productos

En **Administración → Productos** se cargan de a uno. Cada producto pertenece a un
**grupo** (se elige de la lista de la pestaña *Grupos*) y se vende **por peso**
(precio por kilo, toma el peso de la balanza) o **por unidad** (se suma de a uno,
ideal para lo que se escanea).

Los grupos se crean, se renombran, se dan de baja y se ordenan en
**Administración → Grupos**. Dar de baja un grupo no borra sus productos: solo deja
de aparecer en la pantalla de venta.

Para cargar muchos de una, **Administración → Importar** acepta las filas pegadas
directamente desde Excel:

```
nombre ; marca ; grupo ; tipo ; precio ; código de barras
Jamón cocido;Paladini;Jamones;peso;12500;
Gaseosa 500ml;Coca Cola;Gaseosas;unidad;1500;7790895000997
```

Los grupos y las marcas que no existan se dan de alta solos al importar.

El botón *Previsualizar* muestra qué va a importar antes de confirmar.

---

## El lector de código de barras

Cualquier lector USB común sirve. Se comporta como un teclado: no hay que instalar
nada ni configurar nada. Basta con que la pantalla de venta esté abierta y se escanee;
el artículo se agrega solo.

Para que funcione, el producto tiene que tener cargado su código de barras.

Eso vale para un lector enchufado **al mismo equipo donde se vende** (modo teclado).
Si los lectores van enchufados a la PC servidor y se vende desde tablets o celulares,
ver la sección siguiente: hay que pasarlos a modo USB-COM.

---

## Estaciones de trabajo (varias balanzas y escáneres)

Cada **estación** es un puesto de venta con su balanza y su escáner. Se arman en
**Administración → Estaciones**. Con una sola balanza hay una sola estación
("Mostrador 1") y no cambia nada.

- Las balanzas y los escáneres van enchufados a la PC servidor.
- Cada tablet/celular/PC de venta pregunta **una vez** en qué estación trabaja y lo
  recuerda. Se cambia tocando el nombre de la estación, arriba del peso.
- Cada equipo ve solo el peso de su balanza y recibe solo los códigos de su escáner.
  Si hay dos equipos en la misma estación, el código va al último que se tocó.
- Cada venta queda marcada con su estación; en Ventas se ve el total del día por
  estación.

**Balanzas:** con dos balanzas iguales hay dos adaptadores FTDI y Windows les puede
cambiar el número de COM. Atar cada una a su cable con el **número de serie del
adaptador**: Administración → Estaciones → Puertos de esta PC → "Asignar a…"
(o `npm run ports`, que ahora muestra el número de serie). Con número de serie el
POS encuentra la balanza en el COM que esté.

**Escáneres:** en modo de fábrica un escáner USB es un teclado y escribe en la
pantalla de la PC donde está enchufado; Windows no deja leer dos teclados por
separado. Para que la PC reparta los códigos, cada escáner se pasa a modo
**USB-COM** ("USB CDC" / "Virtual COM"), leyendo el código de configuración de su
manual; ahí aparece como un puerto COM y se asigna igual que una balanza. Sin el
equipo se puede probar la ruta con "Enviar a su estación" en la ficha del escáner.

---

## La tablet

Abrí Chrome en la tablet, entrá a la dirección que muestra la consola de la PC y
agregá la página a la pantalla de inicio. Así se abre a pantalla completa, sin barra
de navegación. La tablet y la PC tienen que estar en la misma red.

Conviene fijarle una IP fija a la PC en el router, para que la dirección no cambie.

---

## Cómo se usa

La pantalla base son los **grupos**: jamones, quesos, embutidos, otros fiambres,
gaseosas, con alcohol, almacén. Se toca un grupo y se ven sus productos.

Se apoya el producto en la balanza, se espera a que el peso quede en verde
("Peso estable") y se toca el producto: se agrega al carrito con su peso y su precio
calculado. La pantalla muestra el carrito unos segundos y **vuelve sola a los
grupos**, lista para lo siguiente. Se tara la balanza, se apoya lo que sigue y se
repite. Con el lector de código de barras pasa lo mismo, sin pasar por los grupos.

Esos segundos se configuran en `config.json` → `venta.segundosCarrito` (5 por
defecto). Si se toca la pantalla mientras corre la cuenta, la vuelta automática se
frena y queda esperando el botón *Volver a los grupos*.

**Acomodar los grupos:** manteniendo apretado un grupo se entra al modo ordenar
(o con el botón *Ordenar*); ahí se arrastran a gusto y se toca *Listo*. El orden
queda guardado y es el mismo que muestra la pestaña *Grupos* de administración.

Para sacar algo del carrito, se desliza el renglón hacia cualquier costado.
Los artículos por unidad tienen además los botones − y + .

El botón verde de abajo cierra la venta: la guarda en la base y deja el carrito vacío
esperando lo siguiente.

**Aviso de tara:** si se pesa una cosa atrás de otra sin tarar, la app se da cuenta
(la balanza nunca volvió a cero) y ofrece descontar el peso anterior con un botón.
No bloquea nada, solo avisa.

---

## Verificar que todo funciona

```
node scripts/test-humo.js    prueba la API: pesos, ventas, totales, validaciones
node scripts/test-grupos.js  prueba los grupos: alta, orden, renombrado, importación
node scripts/test-ui.js      prueba la pantalla con un navegador real
node scripts/test-estaciones.js  dos balanzas y dos escáneres simulados en dos estaciones
                                 (usa config y base temporales, puerto 3057)
node scripts/test-deploy.js  lo que usa el actualizador automático (puerto 3058)
npm test                     todas menos la de pantalla
```

El segundo necesita Playwright instalado y deja capturas en `capturas/`.

---

## Cómo está armado

```
config.json              balanzas, escáneres, estaciones, venta, sheets
src/server.js            único proceso: API + WebSocket + interfaz
src/estaciones.js        estaciones: arranca un driver por balanza/escáner y reparte
src/puertos.js           qué COM abre cada equipo (número de serie, autodetección)
src/escaner/driver.js    escáner por puerto serie (modo USB-COM)
src/db.js                todo el SQL del sistema
src/scale/driver.js      lectura del puerto serie, estabilidad, simulador
src/scale/parsers.js     formatos de trama de las balanzas
src/routes/api.js        endpoints REST
public/                  la interfaz (sin build, se edita y se recarga)
scripts/                 diagnóstico de balanza, datos de ejemplo, pruebas
data/pos.db              la base (se crea sola)
```

Dos decisiones que conviene respetar al tocar el código:

**La plata se guarda en centavos y el peso en gramos, siempre como enteros.**
Nunca decimales para plata: acumulan errores de redondeo que después no cierran.

**Los totales los calcula el servidor, no el navegador.** Lo que manda la tablet es
qué producto y qué cantidad; el precio sale siempre del catálogo. Aunque alguien
manipule la pantalla, no puede cambiar lo que se cobra.

Cada venta guarda además una copia del nombre y del precio del momento, así el
historial no se altera cuando después se actualizan los precios.

---

## Respaldo

Toda la información está en `data/pos.db`. Copiarlo es todo el backup.
Conviene copiarlo a un pendrive o a una carpeta en la nube cada tanto.

---

## Migrar a Postgres más adelante

Todo el SQL está en `src/db.js` y nada más lo toca. Para migrar se reemplaza ese
archivo manteniendo las mismas funciones exportadas. Los cambios de sintaxis son
pocos: `AUTOINCREMENT` pasa a `GENERATED ALWAYS AS IDENTITY`, `datetime('now')` a
`now()`, y las sentencias preparadas de better-sqlite3 a consultas con `pg`.

El esquema ya está pensado para eso: claves foráneas explícitas, índices donde hacen
falta, y nada de tipos propios de SQLite.

---

## Lo que queda pendiente

- Parser exacto del modelo de balanza (sale del diagnóstico).
- Integración con ARCA. La tabla `ventas` ya tiene las columnas
  `arca_estado`, `arca_cae` y `arca_payload`, y un índice para buscar las
  pendientes de envío.
- Impresión de ticket.

---

## Copia de ventas a Google Sheets (transición)

Mientras conviven el POS y la planilla vieja del bot de Telegram, cada venta cerrada
se copia también a Google Sheets como una fila `cliente` en la hoja del mes
(`Fecha | Hora | cliente | Monto | TRUE`). Así los totales del bot y el dashboard
siguen dando bien.

- La venta se guarda primero en la base local; si no hay internet la caja sigue
  andando y la copia queda pendiente. Se reintenta sola cada minuto.
- En **Administración → Ventas** se ven las pendientes, las copiadas, el último error
  y un botón *Reintentar ahora*.
- La planilla descarta envíos repetidos, así que un reintento no duplica filas.

Configuración en `config.json`:

```
"sheets": {
  "habilitado": true,
  "url": "<URL /exec del webapp de Apps Script>",
  "token": "<igual a CONFIG.POS_TOKEN en config.gs>",
  "reintentoSegundos": 60
}
```

Del lado de Apps Script: `pos.gs` (nuevo), el desvío `origen === 'pos'` al principio
de `doPost` en `webhook.gs`, y `POS_TOKEN` en `config.gs`. Después de pegar esos
cambios hay que publicar **una versión nueva** del webapp (Implementar → Administrar
implementaciones → editar → Versión: nueva). Si no, el POS recibe HTML en vez de
JSON y lo avisa como error.

Para cortar la copia cuando termine la transición: `"habilitado": false` y reiniciar
el POS. Los scripts de prueba (`test-humo`, `test-ui`) nunca copian a la planilla.

---

## Pasar a otra PC y dejarlo corriendo solo

**En la PC actual** (puede estar el POS andando):

```
empaquetar.bat        (o: npm run empaquetar)
```

Deja `dist\BalanzaPOS-AAAAMMDD-HHMM.zip` con todo lo necesario: la aplicación, las
dependencias ya compiladas, el propio Node (`runtime\node.exe`) y una copia de la base
con productos, grupos, marcas y ventas. La otra PC **no necesita instalar Node ni
tener internet** para instalarlo.

**En la PC nueva:**

1. Descomprimir el zip en `C:\BalanzaPOS` (evitar el Escritorio o carpetas de un usuario).
2. Doble clic en `instalar.bat` y aceptar el permiso de administrador.
3. Conectar la balanza y revisar en **Administración → Balanza** que el puerto COM sea
   el que le tocó en esta PC (Administrador de dispositivos → Puertos COM y LPT).

`instalar.bat` hace:

- Crea la tarea programada **BalanzaPOS**, que arranca el POS al prender la PC, sin que
  nadie tenga que iniciar sesión. Si el proceso se cae, se relanza solo a los 5 segundos.
- Abre el puerto 3000 en el firewall, solo para la red local.
- Desactiva la suspensión con la PC enchufada, porque si la PC se duerme, el celular
  pierde el POS.
- Crea en el escritorio los accesos **Balanza POS** y **Balanza POS - Administración**,
  que abren en ventana de aplicación (Edge sin barra de direcciones).
- Al terminar muestra las direcciones para entrar.

**Desde el celular o la tablet:** tienen que estar en la misma red (wifi o cable).
Se entra por `http://<IP de la PC>:3000`. Las direcciones se ven en **Administración →
Balanza → Entrar desde otro equipo**. Conviene reservar una IP fija para la PC en el
router, así la dirección no cambia.

Otros comandos, todos en la carpeta instalada:

    detener.bat       frena el POS (para copiar la base o actualizar)
    iniciar.bat       lo vuelve a arrancar de fondo
    desinstalar.bat   saca el arranque automático, el firewall y los accesos
                      (no borra la carpeta ni la base)
    logs\pos.log      salida del servidor (se rota sola a los ~5 MB)

**Actualizar la versión** en la PC nueva: con el despliegue automático (abajo) se
actualiza sola. Sin internet: `detener.bat` → reemplazar `src`, `public` y `scripts`
(no tocar `data` ni `config.json`) → `iniciar.bat`.

## Despliegue automático desde GitHub

Cada `git push` a `main` se prueba en GitHub Actions y, si pasa, la PC del POS lo
baja e instala sola cuando la caja está libre (sin carrito y un minuto sin uso),
con respaldo de la base y vuelta atrás automática si la versión nueva no arranca.
La puesta en marcha es `instalador\ci-instalar.bat` en la PC del POS, una sola vez.
Todo el detalle en [docs/CICD.md](docs/CICD.md).

`config.json` ya no se sube al repositorio (cada PC tiene el suyo); si falta, el POS
lo crea desde `config.example.json`.
