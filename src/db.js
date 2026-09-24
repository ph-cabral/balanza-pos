'use strict';

/**
 * Capa de acceso a datos.
 *
 * Todo el SQL del sistema vive en este archivo. Si mañana se migra a Postgres,
 * se reemplaza solo este módulo (misma superficie de funciones exportadas).
 *
 * Decisiones:
 *  - El dinero se guarda en CENTAVOS (INTEGER). Nunca floats para plata.
 *  - El peso se guarda en GRAMOS (INTEGER). Nunca floats para cantidades.
 *  - Cada item de venta guarda un "snapshot" del nombre y del precio, para que
 *    el historial no cambie cuando se actualizan los precios del producto.
 *  - Sentencias preparadas una sola vez (better-sqlite3 las cachea compiladas).
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// POS_DATA permite correr las pruebas sobre otra carpeta sin tocar la base real.
const DATA_DIR = process.env.POS_DATA || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'pos.db'));

// --- Pragmas de performance -------------------------------------------------
// WAL: lecturas y escrituras no se bloquean entre si. Clave con volumen alto.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -16000'); // ~16MB de cache. Suficiente y liviano.

// --- Esquema ----------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS marcas (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre    TEXT    NOT NULL,
  activo    INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Nombre unico sin importar mayusculas, para no duplicar "Paladini" / "paladini".
CREATE UNIQUE INDEX IF NOT EXISTS ux_marcas_nombre ON marcas(nombre COLLATE NOCASE);

-- Grupos del punto de venta (jamones, quesos, gaseosas, con alcohol...).
-- Reemplazan a la categoria escrita a mano: son la pantalla principal del POS,
-- por eso llevan "orden" (se acomoda arrastrando los grupos en la tablet).
CREATE TABLE IF NOT EXISTS categorias (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre    TEXT    NOT NULL,
  orden     INTEGER NOT NULL DEFAULT 0,
  activo    INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_categorias_nombre ON categorias(nombre COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS ix_categorias_orden ON categorias(activo, orden);

CREATE TABLE IF NOT EXISTS productos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo_barras   TEXT,
  nombre          TEXT    NOT NULL,
  marca           TEXT    NOT NULL DEFAULT '',
  marca_id        INTEGER REFERENCES marcas(id),
  categoria       TEXT    NOT NULL DEFAULT 'General',
  tipo            TEXT    NOT NULL CHECK (tipo IN ('peso','unidad')),
  precio_centavos INTEGER NOT NULL CHECK (precio_centavos >= 0),
  activo          INTEGER NOT NULL DEFAULT 1,
  creado_en       TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  actualizado_en  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Busqueda por codigo de barras: es el camino caliente del escaner.
CREATE UNIQUE INDEX IF NOT EXISTS ux_productos_codigo
  ON productos(codigo_barras) WHERE codigo_barras IS NOT NULL AND codigo_barras <> '';

-- Listado del POS: filtra por activo y ordena por categoria/nombre.
CREATE INDEX IF NOT EXISTS ix_productos_activo_cat
  ON productos(activo, categoria, nombre);

CREATE TABLE IF NOT EXISTS ventas (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha          TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  total_centavos INTEGER NOT NULL,
  items_count    INTEGER NOT NULL,
  estado         TEXT    NOT NULL DEFAULT 'cerrada',
  -- Reservado para la integracion futura con ARCA.
  arca_estado    TEXT    NOT NULL DEFAULT 'pendiente',
  arca_cae       TEXT,
  arca_payload   TEXT
);

-- Reportes por fecha y la cola de envio a ARCA.
CREATE INDEX IF NOT EXISTS ix_ventas_fecha ON ventas(fecha DESC);
CREATE INDEX IF NOT EXISTS ix_ventas_arca  ON ventas(arca_estado) WHERE arca_estado = 'pendiente';

CREATE TABLE IF NOT EXISTS venta_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  venta_id         INTEGER NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  producto_id      INTEGER REFERENCES productos(id),
  nombre           TEXT    NOT NULL,
  marca            TEXT    NOT NULL DEFAULT '',
  tipo             TEXT    NOT NULL CHECK (tipo IN ('peso','unidad')),
  -- 'peso'   -> cantidad en gramos
  -- 'unidad' -> cantidad en unidades
  cantidad         INTEGER NOT NULL,
  precio_centavos  INTEGER NOT NULL,
  subtotal_centavos INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_items_venta ON venta_items(venta_id);
CREATE INDEX IF NOT EXISTS ix_items_producto ON venta_items(producto_id);

-- Cola de envio a Google Sheets (etapa de transicion: cada venta se copia a la
-- planilla vieja). Una fila por venta; se reintenta hasta que la planilla la acepta.
CREATE TABLE IF NOT EXISTS sheets_cola (
  venta_id     INTEGER PRIMARY KEY REFERENCES ventas(id) ON DELETE CASCADE,
  estado       TEXT    NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','enviada')),
  intentos     INTEGER NOT NULL DEFAULT 0,
  ultimo_error TEXT,
  creado_en    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  enviado_en   TEXT
);

CREATE INDEX IF NOT EXISTS ix_sheets_pend ON sheets_cola(venta_id) WHERE estado = 'pendiente';

CREATE TABLE IF NOT EXISTS config_kv (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
`);

// --- Migracion: productos ya existentes no tienen columna marca_id ----------
// (CREATE TABLE IF NOT EXISTS no agrega columnas a una tabla que ya existia).
const columnasProductos = db.prepare(`PRAGMA table_info(productos)`).all();
if (!columnasProductos.some((c) => c.name === 'marca_id')) {
  db.exec(`ALTER TABLE productos ADD COLUMN marca_id INTEGER REFERENCES marcas(id)`);
}

// El indice se crea recien aca: si se declarara junto al resto del esquema,
// fallaria en las bases viejas porque la columna todavia no existe cuando
// corre ese primer db.exec().
// Para el select de marca en el alta de producto y para no escanear la tabla
// cuando se filtra o se borra una marca en uso.
db.exec(`CREATE INDEX IF NOT EXISTS ix_productos_marca ON productos(marca_id)`);

// Da de alta en "marcas" cada texto distinto que haya en productos.marca y
// enlaza marca_id. Idempotente: no repite marcas ya migradas.
db.transaction(() => {
  const marcasUsadas = db.prepare(`
    SELECT DISTINCT marca FROM productos
    WHERE marca_id IS NULL AND TRIM(marca) <> ''
  `).all();
  const crearMarca = db.prepare(`
    INSERT INTO marcas (nombre) VALUES (?)
    ON CONFLICT(nombre COLLATE NOCASE) DO NOTHING
  `);
  const idPorNombre = db.prepare(`SELECT id FROM marcas WHERE nombre = ? COLLATE NOCASE`);
  const enlazar = db.prepare(`UPDATE productos SET marca_id = ? WHERE marca_id IS NULL AND marca = ?`);
  for (const { marca } of marcasUsadas) {
    crearMarca.run(marca.trim());
    const fila = idPorNombre.get(marca.trim());
    if (fila) enlazar.run(fila.id, marca);
  }
})();

// --- Migracion: de "categoria" (texto libre) a grupos -----------------------
// Los grupos son la pantalla principal del POS. Antes la categoria era un texto
// suelto en cada producto; ahora vive en su propia tabla, con orden propio, y el
// producto la referencia por id. El texto queda denormalizado en productos.categoria
// (igual que la marca) para que el listado caliente del POS no necesite JOIN.
if (!db.prepare(`PRAGMA table_info(productos)`).all().some((c) => c.name === 'categoria_id')) {
  db.exec(`ALTER TABLE productos ADD COLUMN categoria_id INTEGER REFERENCES categorias(id)`);
}
db.exec(`CREATE INDEX IF NOT EXISTS ix_productos_categoria ON productos(categoria_id)`);

// Grupos con los que arranca una instalacion nueva, en este orden.
const GRUPOS_INICIALES = [
  'Jamones', 'Quesos', 'Embutidos', 'Otros fiambres',
  'Gaseosas', 'Con alcohol', 'Almacén',
];

// Reparto de los productos que todavia no tienen grupo. Primero manda el nombre
// del producto; si no dice nada, la categoria vieja.
function grupoSugerido(nombre, categoriaVieja) {
  const n = String(nombre || '').toLowerCase();
  const c = String(categoriaVieja || '').toLowerCase();

  if (/queso|muzz|provolone|roquefort|sardo|pategr[aá]s|cremoso|port salut|rall/.test(n)) return 'Quesos';
  if (/jam[oó]n|paleta/.test(n)) return 'Jamones';
  if (/salam|mortadela|chorizo|longaniza|morcilla|salchich|sopres|cantimpalo/.test(n)) return 'Embutidos';
  if (/bondiola|lomito|panceta|pastr[oó]n|matambre|arrollado|leberwurst/.test(n)) return 'Otros fiambres';
  if (/cerveza|vino|fernet|aperitivo|licor|whisky|gin|vodka|champ|sidra|ron |amargo/.test(n)) return 'Con alcohol';
  if (/gaseosa|coca|sprite|fanta|pepsi|agua|soda|t[oó]nica|jugo|isot[oó]nic/.test(n)) return 'Gaseosas';

  if (c === 'quesos' || c === 'lácteos' || c === 'lacteos') return 'Quesos';
  if (c === 'fiambres' || c === 'fiambre') return 'Otros fiambres';
  if (c === 'bebidas') return 'Gaseosas';
  return 'Almacén';
}

// Icono sugerido para un grupo segun su nombre (se usa al crearlo y en la
// migracion). Emojis: no necesitan archivos y se ven en Windows y Android.
function iconoSugerido(nombre) {
  const n = String(nombre || '').toLowerCase();
  const reglas = [
    [/jam[oó]n/, '🍖'],
    [/queso/, '🧀'],
    [/embutid|salam|chorizo|salchich/, '🌭'],
    [/fiambre|bondiola|panceta|lomito/, '🥓'],
    [/crema|l[aá]cteo|leche|yogur|manteca/, '🥛'],
    [/cerveza/, '🍺'],
    [/alcohol|vino|fernet|aperitivo|licor/, '🍷'],
    [/jugo/, '🧃'],
    [/gaseosa|pepsi|coca|bebida|refresco/, '🥤'],
    [/agua|soda/, '💧'],
    [/pan\b|panader|galleta/, '🍞'],
    [/galletit/, '🍪'],
    [/dulce|golosina|alfajor|chocolate/, '🍫'],
    [/snack|papas|mani|man[ií]/, '🍿'],
    [/huevo/, '🥚'],
    [/carne|vacun/, '🥩'],
    [/pollo/, '🍗'],
    [/pasta|fideo/, '🍝'],
    [/caf[eé]|infusi|yerba|t[eé]\b/, '☕'],
    [/fruta|verdura/, '🍎'],
    [/congelad|helado|hielo/, '🧊'],
    [/limpieza|perfumer/, '🧴'],
    [/almac[eé]n/, '🛒'],
  ];
  for (const [re, ico] of reglas) if (re.test(n)) return ico;
  return '📦';
}

// Un icono es un emoji (o un par de caracteres): se recorta para que no entre texto largo.
function limpiarIcono(v) {
  const t = (v ?? '').toString().trim();
  return t ? Array.from(t).slice(0, 4).join('') : '';
}

const Sm = {
  contarCategorias: db.prepare(`SELECT COUNT(*) AS n FROM categorias`),
  insertarCategoriaOrden: db.prepare(`INSERT INTO categorias (nombre, orden) VALUES (?, ?)`),
  categoriaPorNombre: db.prepare(`SELECT id, nombre FROM categorias WHERE nombre = ? COLLATE NOCASE`),
  maxOrden: db.prepare(`SELECT COALESCE(MAX(orden), 0) AS m FROM categorias`),
  sinCategoria: db.prepare(`SELECT id, nombre, categoria FROM productos WHERE categoria_id IS NULL`),
  enlazarCategoria: db.prepare(`UPDATE productos SET categoria_id = @id, categoria = @nombre WHERE id = @producto`),
};

// Base nueva (o base vieja que todavia no vio esta migracion): se cargan los
// grupos iniciales una sola vez.
if (Sm.contarCategorias.get().n === 0) {
  db.transaction(() => {
    GRUPOS_INICIALES.forEach((nombre, i) => Sm.insertarCategoriaOrden.run(nombre, i + 1));
  })();
}

// Enlaza los productos que todavia no tienen grupo. Idempotente: los que ya
// quedaron enlazados no se vuelven a tocar.
db.transaction(() => {
  for (const p of Sm.sinCategoria.all()) {
    // 1) si el texto que ya tenia coincide con un grupo, ese es;
    // 2) si no, se reparte por nombre / categoria vieja;
    // 3) si aun asi no hay grupo con ese nombre, se crea al final (no se pierde nada).
    let fila = p.categoria ? Sm.categoriaPorNombre.get(p.categoria.trim()) : null;
    if (!fila) fila = Sm.categoriaPorNombre.get(grupoSugerido(p.nombre, p.categoria));
    if (!fila) {
      const nombre = (p.categoria || '').trim() || 'Almacén';
      Sm.insertarCategoriaOrden.run(nombre, Sm.maxOrden.get().m + 1);
      fila = Sm.categoriaPorNombre.get(nombre);
    }
    Sm.enlazarCategoria.run({ id: fila.id, nombre: fila.nombre, producto: p.id });
  }
})();

// --- Migracion: icono de cada grupo -----------------------------------------
// Un emoji por grupo para reconocerlo de un vistazo en la tablet. Los grupos que
// no tienen icono reciben uno sugerido por nombre; despues se cambia a mano
// desde Administracion -> Grupos.
if (!db.prepare(`PRAGMA table_info(categorias)`).all().some((c) => c.name === 'icono')) {
  db.exec(`ALTER TABLE categorias ADD COLUMN icono TEXT`);
}
db.transaction(() => {
  const sinIcono = db.prepare(`SELECT id, nombre FROM categorias WHERE icono IS NULL OR icono = ''`).all();
  const fijar = db.prepare(`UPDATE categorias SET icono = ? WHERE id = ?`);
  for (const c of sinIcono) fijar.run(iconoSugerido(c.nombre), c.id);
})();

// --- Migracion: detalle completo en venta_items -----------------------------
// Cada item guarda tambien el grupo y el codigo de barras del producto al momento
// de la venta (snapshot, igual que nombre/marca/precio), para poder analizar
// ventas por grupo o por codigo aunque despues se reclasifique el producto.
{
  const cols = db.prepare(`PRAGMA table_info(venta_items)`).all().map((c) => c.name);
  if (!cols.includes('categoria')) db.exec(`ALTER TABLE venta_items ADD COLUMN categoria TEXT NOT NULL DEFAULT ''`);
  if (!cols.includes('codigo_barras')) db.exec(`ALTER TABLE venta_items ADD COLUMN codigo_barras TEXT`);
}

// --- Migracion: estacion de trabajo en cada venta ---------------------------
// Con varias estaciones (cada una con su balanza y su escaner) cada venta guarda
// en cual se hizo: el id y el nombre del momento (snapshot). Las ventas
// anteriores quedan vacias.
{
  const cols = db.prepare(`PRAGMA table_info(ventas)`).all().map((c) => c.name);
  if (!cols.includes('estacion_id')) db.exec(`ALTER TABLE ventas ADD COLUMN estacion_id TEXT`);
  if (!cols.includes('estacion')) db.exec(`ALTER TABLE ventas ADD COLUMN estacion TEXT NOT NULL DEFAULT ''`);
}

// --- Sentencias preparadas --------------------------------------------------
const S = {
  listarProductos: db.prepare(`
    SELECT id, codigo_barras, nombre, marca, marca_id, categoria, categoria_id, tipo, precio_centavos, activo
    FROM productos
    WHERE activo = 1
    ORDER BY nombre, marca
  `),

  listarTodos: db.prepare(`
    SELECT id, codigo_barras, nombre, marca, marca_id, categoria, categoria_id, tipo, precio_centavos, activo
    FROM productos
    ORDER BY activo DESC, nombre, marca
  `),

  porId: db.prepare(`
    SELECT id, codigo_barras, nombre, marca, marca_id, categoria, categoria_id, tipo, precio_centavos, activo
    FROM productos WHERE id = ?
  `),

  porCodigo: db.prepare(`
    SELECT id, codigo_barras, nombre, marca, marca_id, categoria, categoria_id, tipo, precio_centavos, activo
    FROM productos WHERE codigo_barras = ? AND activo = 1
  `),

  insertarProducto: db.prepare(`
    INSERT INTO productos (codigo_barras, nombre, marca, marca_id, categoria, categoria_id, tipo, precio_centavos, activo)
    VALUES (@codigo_barras, @nombre, @marca, @marca_id, @categoria, @categoria_id, @tipo, @precio_centavos, @activo)
  `),

  actualizarProducto: db.prepare(`
    UPDATE productos SET
      codigo_barras   = @codigo_barras,
      nombre          = @nombre,
      marca           = @marca,
      marca_id        = @marca_id,
      categoria       = @categoria,
      categoria_id    = @categoria_id,
      tipo            = @tipo,
      precio_centavos = @precio_centavos,
      activo          = @activo,
      actualizado_en  = datetime('now','localtime')
    WHERE id = @id
  `),

  borrarProducto: db.prepare(`UPDATE productos SET activo = 0 WHERE id = ?`),

  // --- Grupos (categorias) --------------------------------------------------
  // El POS pide solo los activos, ya ordenados como quedaron en la tablet.
  listarCategoriasActivas: db.prepare(`
    SELECT c.id, c.nombre, c.icono, c.orden, c.activo,
           COUNT(p.id) AS productos
    FROM categorias c
    LEFT JOIN productos p ON p.categoria_id = c.id AND p.activo = 1
    WHERE c.activo = 1
    GROUP BY c.id
    ORDER BY c.orden, c.id
  `),

  listarCategoriasTodas: db.prepare(`
    SELECT c.id, c.nombre, c.icono, c.orden, c.activo,
           COUNT(p.id) AS productos
    FROM categorias c
    LEFT JOIN productos p ON p.categoria_id = c.id AND p.activo = 1
    GROUP BY c.id
    ORDER BY c.activo DESC, c.orden, c.id
  `),

  categoriaPorId: db.prepare(`SELECT id, nombre, icono, orden, activo FROM categorias WHERE id = ?`),

  categoriaPorNombreExacto: db.prepare(`
    SELECT id, nombre FROM categorias WHERE nombre = ? COLLATE NOCASE
  `),

  insertarCategoria: db.prepare(`INSERT INTO categorias (nombre, orden, icono) VALUES (@nombre, @orden, @icono)`),

  actualizarCategoria: db.prepare(`UPDATE categorias SET nombre = @nombre, activo = @activo, icono = @icono WHERE id = @id`),

  borrarCategoria: db.prepare(`UPDATE categorias SET activo = 0 WHERE id = ?`),

  fijarOrdenCategoria: db.prepare(`UPDATE categorias SET orden = @orden WHERE id = @id`),

  proximoOrden: db.prepare(`SELECT COALESCE(MAX(orden), 0) + 1 AS siguiente FROM categorias`),

  // Al renombrar un grupo se actualiza el texto que quedo copiado en productos.
  resincronizarCategoriaEnProductos: db.prepare(`
    UPDATE productos SET categoria = @nombre WHERE categoria_id = @id
  `),

  primeraCategoria: db.prepare(`
    SELECT id, nombre FROM categorias WHERE activo = 1 ORDER BY orden, id LIMIT 1
  `),

  // --- Marcas ---------------------------------------------------------------
  listarMarcasActivas: db.prepare(`
    SELECT id, nombre, activo FROM marcas WHERE activo = 1 ORDER BY nombre COLLATE NOCASE
  `),

  listarMarcasTodas: db.prepare(`
    SELECT m.id, m.nombre, m.activo, COUNT(p.id) AS productos
    FROM marcas m
    LEFT JOIN productos p ON p.marca_id = m.id AND p.activo = 1
    GROUP BY m.id
    ORDER BY m.activo DESC, m.nombre COLLATE NOCASE
  `),

  marcaPorId: db.prepare(`SELECT id, nombre, activo FROM marcas WHERE id = ?`),

  insertarMarca: db.prepare(`INSERT INTO marcas (nombre) VALUES (?)`),

  actualizarMarca: db.prepare(`UPDATE marcas SET nombre = @nombre, activo = @activo WHERE id = @id`),

  borrarMarca: db.prepare(`UPDATE marcas SET activo = 0 WHERE id = ?`),

  // Al renombrar una marca, el texto ya guardado en productos (denormalizado
  // para no tener que hacer JOIN en el listado caliente del POS) se actualiza
  // junto con ella.
  resincronizarMarcaEnProductos: db.prepare(`
    UPDATE productos SET marca = @nombre WHERE marca_id = @id
  `),

  insertarVenta: db.prepare(`
    INSERT INTO ventas (total_centavos, items_count, estacion_id, estacion) VALUES (?, ?, ?, ?)
  `),

  insertarItem: db.prepare(`
    INSERT INTO venta_items
      (venta_id, producto_id, nombre, marca, categoria, codigo_barras, tipo, cantidad, precio_centavos, subtotal_centavos)
    VALUES
      (@venta_id, @producto_id, @nombre, @marca, @categoria, @codigo_barras, @tipo, @cantidad, @precio_centavos, @subtotal_centavos)
  `),

  ventasRecientes: db.prepare(`
    SELECT id, fecha, total_centavos, items_count, arca_estado, estacion_id, estacion
    FROM ventas ORDER BY id DESC LIMIT ?
  `),

  ventaPorId: db.prepare(`
    SELECT id, fecha, total_centavos, items_count, estado, arca_estado, arca_cae, estacion_id, estacion
    FROM ventas WHERE id = ?
  `),

  itemsDeVenta: db.prepare(`
    SELECT producto_id, nombre, marca, categoria, codigo_barras, tipo, cantidad, precio_centavos, subtotal_centavos
    FROM venta_items WHERE venta_id = ? ORDER BY id
  `),

  resumenDia: db.prepare(`
    SELECT COUNT(*) AS ventas, COALESCE(SUM(total_centavos),0) AS total_centavos
    FROM ventas
    WHERE fecha >= date('now','localtime') || ' 00:00:00'
  `),

  resumenDiaPorEstacion: db.prepare(`
    SELECT estacion, COUNT(*) AS ventas, COALESCE(SUM(total_centavos),0) AS total_centavos
    FROM ventas
    WHERE fecha >= date('now','localtime') || ' 00:00:00'
    GROUP BY estacion ORDER BY estacion
  `),

  // Totales para Administracion -> Ventas. `fecha` es texto local
  // 'AAAA-MM-DD HH:MM:SS', asi que el dia y el mes salen con substr y el
  // rango del mes usa el indice ix_ventas_fecha.
  totalesPorMes: db.prepare(`
    SELECT substr(fecha, 1, 7) AS mes,
           COUNT(*) AS ventas,
           COALESCE(SUM(total_centavos), 0) AS total_centavos,
           COUNT(DISTINCT substr(fecha, 1, 10)) AS dias_con_ventas
    FROM ventas
    GROUP BY mes ORDER BY mes DESC LIMIT ?
  `),

  totalesPorDia: db.prepare(`
    SELECT substr(fecha, 1, 10) AS dia,
           COUNT(*) AS ventas,
           COALESCE(SUM(total_centavos), 0) AS total_centavos
    FROM ventas
    WHERE fecha >= @desde AND fecha < @hasta
    GROUP BY dia ORDER BY dia
  `),

  hoyLocal: db.prepare(`SELECT date('now','localtime') AS hoy`),

  sheetsEncolar: db.prepare(`INSERT OR IGNORE INTO sheets_cola (venta_id) VALUES (?)`),
  sheetsPendientes: db.prepare(`
    SELECT c.venta_id AS id, v.fecha, v.total_centavos
    FROM sheets_cola c JOIN ventas v ON v.id = c.venta_id
    WHERE c.estado = 'pendiente'
    ORDER BY c.venta_id LIMIT ?
  `),
  sheetsOk: db.prepare(`
    UPDATE sheets_cola
    SET estado = 'enviada', intentos = intentos + 1, ultimo_error = NULL,
        enviado_en = datetime('now','localtime')
    WHERE venta_id = ?
  `),
  sheetsError: db.prepare(`
    UPDATE sheets_cola SET intentos = intentos + 1, ultimo_error = ? WHERE venta_id = ?
  `),
  sheetsResumen: db.prepare(`
    SELECT
      COALESCE(SUM(estado = 'pendiente'), 0) AS pendientes,
      COALESCE(SUM(estado = 'enviada'), 0)   AS enviadas,
      MAX(enviado_en)                        AS ultimo_envio
    FROM sheets_cola
  `),
  sheetsUltimoError: db.prepare(`
    SELECT venta_id, ultimo_error FROM sheets_cola
    WHERE estado = 'pendiente' AND ultimo_error IS NOT NULL
    ORDER BY venta_id DESC LIMIT 1
  `),

  getConfig: db.prepare(`SELECT valor FROM config_kv WHERE clave = ?`),
  setConfig: db.prepare(`
    INSERT INTO config_kv (clave, valor) VALUES (?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor
  `),
};

// --- Helpers de normalizacion ----------------------------------------------
function limpiarCodigo(c) {
  const s = (c ?? '').toString().trim();
  return s === '' ? null : s;
}

/**
 * La marca se elige de la tabla "marcas" (marca_id). El texto en
 * productos.marca queda denormalizado a partir de ahi, para que el listado
 * caliente del POS no necesite un JOIN.
 */
function resolverMarca(marca_id) {
  if (marca_id === undefined || marca_id === null || marca_id === '') {
    return { marca_id: null, marca: '' };
  }
  const id = Number(marca_id);
  const fila = S.marcaPorId.get(id);
  if (!fila) throw new Error('La marca elegida no existe');
  return { marca_id: fila.id, marca: fila.nombre };
}

const buscarMarcaPorNombre = db.prepare(`SELECT id FROM marcas WHERE nombre = ? COLLATE NOCASE`);

/**
 * Solo para la importacion masiva desde planilla, que trae la marca como
 * texto suelto: la busca (sin importar mayusculas) o la da de alta.
 */
function resolverOCrearMarcaPorNombre(nombre) {
  const limpio = (nombre ?? '').toString().trim();
  if (!limpio) return null;
  const existente = buscarMarcaPorNombre.get(limpio);
  if (existente) return existente.id;
  const info = S.insertarMarca.run(limpio);
  return info.lastInsertRowid;
}

/**
 * El grupo se elige de la tabla "categorias" (categoria_id). Si viene solo el
 * nombre —el caso de la importacion desde planilla— se busca o se da de alta.
 * Si no viene nada, cae en el primer grupo de la lista.
 */
function resolverCategoria(categoria_id, categoriaTexto) {
  if (categoria_id !== undefined && categoria_id !== null && categoria_id !== '') {
    const fila = S.categoriaPorId.get(Number(categoria_id));
    if (!fila) throw new Error('El grupo elegido no existe');
    return { categoria_id: fila.id, categoria: fila.nombre };
  }

  const texto = (categoriaTexto ?? '').toString().trim();
  if (texto) {
    const existente = S.categoriaPorNombreExacto.get(texto);
    if (existente) return { categoria_id: existente.id, categoria: existente.nombre };
    const info = S.insertarCategoria.run({ nombre: texto, orden: S.proximoOrden.get().siguiente, icono: iconoSugerido(texto) });
    const nueva = S.categoriaPorId.get(info.lastInsertRowid);
    return { categoria_id: nueva.id, categoria: nueva.nombre };
  }

  const primera = S.primeraCategoria.get();
  if (primera) return { categoria_id: primera.id, categoria: primera.nombre };

  const info = S.insertarCategoria.run({ nombre: 'General', orden: 1, icono: iconoSugerido('General') });
  return { categoria_id: info.lastInsertRowid, categoria: 'General' };
}

function normalizarProducto(p) {
  const tipo = p.tipo === 'unidad' ? 'unidad' : 'peso';
  const { marca_id, marca } = resolverMarca(p.marca_id);
  const { categoria_id, categoria } = resolverCategoria(p.categoria_id, p.categoria);
  return {
    codigo_barras: limpiarCodigo(p.codigo_barras),
    nombre: (p.nombre ?? '').toString().trim(),
    marca_id,
    marca,
    categoria,
    categoria_id,
    tipo,
    precio_centavos: Math.max(0, Math.round(Number(p.precio_centavos) || 0)),
    activo: p.activo === 0 || p.activo === false ? 0 : 1,
  };
}

// --- API del modulo ---------------------------------------------------------
const api = {
  db,

  listarProductos: () => S.listarProductos.all(),
  listarTodosLosProductos: () => S.listarTodos.all(),
  productoPorId: (id) => S.porId.get(id),
  productoPorCodigo: (codigo) => S.porCodigo.get(codigo),

  // --- Grupos -----------------------------------------------------------
  categorias: () => S.listarCategoriasActivas.all(),
  categoriasTodas: () => S.listarCategoriasTodas.all(),

  crearCategoria(nombre, icono) {
    const limpio = (nombre ?? '').toString().trim();
    if (!limpio) throw new Error('El nombre del grupo es obligatorio');
    const ico = limpiarIcono(icono) || iconoSugerido(limpio);
    const info = S.insertarCategoria.run({ nombre: limpio, orden: S.proximoOrden.get().siguiente, icono: ico });
    return S.categoriaPorId.get(info.lastInsertRowid);
  },

  /**
   * Renombrar o activar/desactivar un grupo. Si cambia el nombre, se propaga al
   * texto que quedo copiado en los productos de ese grupo.
   */
  actualizarCategoria: db.transaction((id, cambios) => {
    const actual = S.categoriaPorId.get(id);
    if (!actual) throw new Error('Grupo no encontrado');
    const nombre = (cambios.nombre ?? actual.nombre).toString().trim();
    if (!nombre) throw new Error('El nombre del grupo es obligatorio');
    const activo = cambios.activo === 0 || cambios.activo === false ? 0 : 1;
    const icono = cambios.icono === undefined ? actual.icono : (limpiarIcono(cambios.icono) || iconoSugerido(nombre));
    S.actualizarCategoria.run({ id, nombre, activo, icono });
    if (nombre !== actual.nombre) S.resincronizarCategoriaEnProductos.run({ id, nombre });
    return S.categoriaPorId.get(id);
  }),

  // Baja logica: los productos que estaban en ese grupo no se tocan, pero el
  // grupo deja de aparecer en la pantalla de venta.
  borrarCategoria: (id) => S.borrarCategoria.run(id),

  /**
   * Guarda el orden en que quedaron los grupos despues de arrastrarlos.
   * Recibe los id en el orden nuevo; los que no vengan en la lista quedan
   * detras, respetando el orden que ya tenian.
   */
  ordenarCategorias: db.transaction((ids) => {
    const lista = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite);
    let n = 0;
    for (const id of lista) {
      if (!S.categoriaPorId.get(id)) continue;
      S.fijarOrdenCategoria.run({ id, orden: ++n });
    }
    for (const c of S.listarCategoriasTodas.all()) {
      if (lista.indexOf(c.id) === -1) S.fijarOrdenCategoria.run({ id: c.id, orden: ++n });
    }
    return S.listarCategoriasTodas.all();
  }),

  crearProducto(p) {
    const n = normalizarProducto(p);
    if (!n.nombre) throw new Error('El nombre es obligatorio');
    const info = S.insertarProducto.run(n);
    return S.porId.get(info.lastInsertRowid);
  },

  actualizarProducto(id, p) {
    const actual = S.porId.get(id);
    if (!actual) throw new Error('Producto no encontrado');
    const n = normalizarProducto({ ...actual, ...p });
    if (!n.nombre) throw new Error('El nombre es obligatorio');
    S.actualizarProducto.run({ ...n, id });
    return S.porId.get(id);
  },

  borrarProducto: (id) => S.borrarProducto.run(id),

  // --- Marcas -----------------------------------------------------------
  listarMarcas: () => S.listarMarcasActivas.all(),
  listarMarcasTodas: () => S.listarMarcasTodas.all(),

  crearMarca(nombre) {
    const limpio = (nombre ?? '').toString().trim();
    if (!limpio) throw new Error('El nombre de la marca es obligatorio');
    const info = S.insertarMarca.run(limpio);
    return S.marcaPorId.get(info.lastInsertRowid);
  },

  /**
   * Renombrar o activar/desactivar una marca. Si cambia el nombre, se
   * propaga al texto denormalizado en los productos que la usan (una sola
   * transaccion, no importa cuantos productos tenga esa marca).
   */
  actualizarMarca: db.transaction((id, cambios) => {
    const actual = S.marcaPorId.get(id);
    if (!actual) throw new Error('Marca no encontrada');
    const nombre = (cambios.nombre ?? actual.nombre).toString().trim();
    if (!nombre) throw new Error('El nombre de la marca es obligatorio');
    const activo = cambios.activo === 0 || cambios.activo === false ? 0 : 1;
    S.actualizarMarca.run({ id, nombre, activo });
    if (nombre !== actual.nombre) S.resincronizarMarcaEnProductos.run({ id, nombre });
    return S.marcaPorId.get(id);
  }),

  // Baja logica: los productos que ya la tenian cargada no se tocan, solo
  // deja de ofrecerse en el alta de productos nuevos.
  borrarMarca: (id) => S.borrarMarca.run(id),

  /**
   * Importa productos en lote dentro de una unica transaccion.
   * Con volumen alto esto es ordenes de magnitud mas rapido que N inserts sueltos.
   */
  importarProductos: db.transaction((lista) => {
    let creados = 0;
    for (const p of lista) {
      // La planilla trae la marca como texto: se resuelve o se da de alta acá
      // (no tiene sentido pedirle a Pablo que precargue marcas antes de pegar
      // un CSV con cientos de filas).
      const marca_id = p.marca_id ?? resolverOCrearMarcaPorNombre(p.marca);
      const n = normalizarProducto({ ...p, marca_id });
      if (!n.nombre) continue;
      S.insertarProducto.run(n);
      creados++;
    }
    return creados;
  }),

  /**
   * Guarda una venta completa (cabecera + items) en una sola transaccion.
   * Recalcula los subtotales del lado del servidor: nunca se confia en el total
   * que manda el navegador.
   */
  // opciones.sheets = true -> la venta queda en la cola de envio a Google Sheets
  // dentro de la misma transaccion (si se guarda la venta, se guarda el pendiente).
  guardarVenta: db.transaction((items, opciones = {}) => {
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('La venta no tiene items');
    }

    const preparados = items.map((it) => {
      const producto = it.producto_id ? S.porId.get(it.producto_id) : null;
      const tipo = it.tipo === 'unidad' ? 'unidad' : 'peso';
      const nombre = producto ? producto.nombre : (it.nombre || 'item sin nombre');
      const cantidad = Math.max(0, Math.round(Number(it.cantidad) || 0));
      if (cantidad <= 0) throw new Error(`Cantidad invalida en "${nombre}"`);

      // El precio sale del producto vigente; si el producto fue borrado, del item.
      const precio = producto
        ? producto.precio_centavos
        : Math.max(0, Math.round(Number(it.precio_centavos) || 0));

      // peso  -> cantidad en gramos, precio por kilo
      // unidad-> cantidad en unidades, precio por unidad
      const subtotal = tipo === 'peso'
        ? Math.round((cantidad * precio) / 1000)
        : cantidad * precio;

      return {
        producto_id: producto ? producto.id : null,
        nombre,
        marca: producto ? producto.marca : (it.marca ?? ''),
        categoria: producto ? (producto.categoria || '') : '',
        codigo_barras: producto ? (producto.codigo_barras || null) : null,
        tipo,
        cantidad,
        precio_centavos: precio,
        subtotal_centavos: subtotal,
      };
    });

    const total = preparados.reduce((a, it) => a + it.subtotal_centavos, 0);
    const est = opciones.estacion || null;
    const info = S.insertarVenta.run(total, preparados.length, est ? est.id : null, est ? est.nombre : '');
    const ventaId = info.lastInsertRowid;

    for (const it of preparados) {
      S.insertarItem.run({ ...it, venta_id: ventaId });
    }

    if (opciones.sheets) S.sheetsEncolar.run(ventaId);

    return { id: ventaId, total_centavos: total, items: preparados.length, estacion: est ? est.nombre : '' };
  }),

  ventasRecientes: (limite = 50) => S.ventasRecientes.all(limite),
  ventaPorId: (id) => {
    const venta = S.ventaPorId.get(id);
    if (!venta) return null;
    return { ...venta, items: S.itemsDeVenta.all(id) };
  },
  hoyLocal: () => S.hoyLocal.get().hoy, // 'AAAA-MM-DD' en hora de la PC
  resumenDia: () => S.resumenDia.get(),
  resumenDiaPorEstacion: () => S.resumenDiaPorEstacion.all(),

  // Total vendido por dia (del mes pedido, 'AAAA-MM'; por defecto el actual)
  // y por mes (ultimos `meses`). Los dias sin ventas vienen en 0 para que se
  // vea cuando no se vendio; del mes en curso, solo hasta hoy.
  totalesVentas: (mesPedido, meses = 24) => {
    const hoy = S.hoyLocal.get().hoy; // 'AAAA-MM-DD'
    const mesActual = hoy.slice(0, 7);
    const mes = /^\d{4}-(0[1-9]|1[0-2])$/.test(mesPedido || '') ? mesPedido : mesActual;

    const [a, m] = mes.split('-').map(Number);
    const sig = m === 12 ? `${a + 1}-01` : `${a}-${String(m + 1).padStart(2, '0')}`;
    const filas = S.totalesPorDia.all({ desde: `${mes}-01 00:00:00`, hasta: `${sig}-01 00:00:00` });
    const porDia = new Map(filas.map((f) => [f.dia, f]));

    const diasEnMes = new Date(a, m, 0).getDate();
    let ultimo = diasEnMes;
    if (mes === mesActual) ultimo = Number(hoy.slice(8, 10));
    else if (mes > mesActual) ultimo = 0;

    const dias = [];
    for (let d = 1; d <= ultimo; d++) {
      const dia = `${mes}-${String(d).padStart(2, '0')}`;
      const f = porDia.get(dia);
      dias.push({ dia, ventas: f ? f.ventas : 0, total_centavos: f ? f.total_centavos : 0 });
    }

    const totalMes = filas.reduce((acc, f) => ({
      ventas: acc.ventas + f.ventas,
      total_centavos: acc.total_centavos + f.total_centavos,
    }), { ventas: 0, total_centavos: 0 });

    return {
      hoy,
      mes,
      dias,
      totalMes: { ...totalMes, dias_con_ventas: filas.length },
      meses: S.totalesPorMes.all(Math.min(120, Math.max(1, meses))),
    };
  },

  // --- Cola de Google Sheets ---
  sheetsPendientes: (limite = 50) => S.sheetsPendientes.all(limite),
  sheetsMarcarOk: db.transaction((ids) => { for (const id of ids) S.sheetsOk.run(id); }),
  sheetsMarcarError: db.transaction((ids, error) => {
    for (const id of ids) S.sheetsError.run(String(error).slice(0, 500), id);
  }),
  sheetsResumen: () => ({ ...S.sheetsResumen.get(), ultimo_error: S.sheetsUltimoError.get() || null }),

  getConfig: (clave) => {
    const row = S.getConfig.get(clave);
    return row ? row.valor : null;
  },
  setConfig: (clave, valor) => S.setConfig.run(clave, String(valor)),
};

module.exports = api;
