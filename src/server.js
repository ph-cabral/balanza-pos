'use strict';

/**
 * Proceso unico: sirve la UI, la API REST y el WebSocket del peso en vivo.
 * Pensado para correr en una PC modesta: sin build, sin framework de frontend,
 * sin motor de base de datos aparte.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const Estaciones = require('./estaciones');
const crearApi = require('./routes/api');
const crearSheets = require('./sheets');
const crearGastos = require('./gastos');
const crearSheetsImportar = require('./sheets-importar');

const RAIZ = path.join(__dirname, '..');
// POS_CONFIG permite correr las pruebas con otra configuracion sin tocar la real.
const RUTA_CONFIG = process.env.POS_CONFIG || path.join(RAIZ, 'config.json');

function leerConfig() {
  // config.json es de cada PC y no se sube a git: en una instalacion nueva se
  // arranca desde config.example.json.
  if (!fs.existsSync(RUTA_CONFIG) && !process.env.POS_CONFIG) {
    fs.copyFileSync(path.join(RAIZ, 'config.example.json'), RUTA_CONFIG);
    console.log('  config.json no existía: se creó desde config.example.json');
  }
  const cfg = JSON.parse(fs.readFileSync(RUTA_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
  aplicarConfigComun(cfg);
  return cfg;
}

// config.comun.json SI va en git: lo que es igual en todas las PC del POS (por
// ejemplo la URL del webapp de Apps Script). Lo que define pisa a config.json,
// asi un cambio llega a la PC del POS con el despliegue automatico sin tener que
// entrar a editarla. Las claves (sheets.token) siguen solo en config.json.
function aplicarConfigComun(cfg) {
  // POS_CONFIG_COMUN: otra ruta (las pruebas la apuntan a un archivo inexistente).
  const ruta = process.env.POS_CONFIG_COMUN || path.join(RAIZ, 'config.comun.json');
  let comun;
  try {
    comun = JSON.parse(fs.readFileSync(ruta, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`  config.comun.json no se pudo leer: ${e.message}`);
    return;
  }
  const esObjeto = (v) => v && typeof v === 'object' && !Array.isArray(v);
  (function mezclar(destino, origen, prefijo) {
    for (const [k, v] of Object.entries(origen)) {
      if (k.startsWith('_')) continue; // comentarios
      if (esObjeto(v)) {
        if (!esObjeto(destino[k])) destino[k] = {};
        mezclar(destino[k], v, `${prefijo}${k}.`);
      } else if (destino[k] !== v) {
        if (destino[k] !== undefined) console.log(`  config.comun.json: ${prefijo}${k} actualizado`);
        destino[k] = v;
      }
    }
  })(cfg, comun, '');
}

// Version instalada: la escribe el actualizador automatico (instalador/actualizar.ps1)
// en version.json. En la PC de desarrollo no existe y queda "dev".
function leerVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(RAIZ, 'version.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (v && v.commit) return v;
  } catch (_) { /* sin archivo */ }
  return { commit: 'dev', corto: 'dev', mensaje: 'versión de desarrollo', fecha: null };
}

function leerEstadoDeploy() {
  try { return JSON.parse(fs.readFileSync(path.join(RAIZ, 'logs', 'deploy-estado.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return null; }
}

const VERSION = leerVersion();
const INICIADO = new Date().toISOString();

function guardarConfig(cfg) {
  fs.writeFileSync(RUTA_CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

const config = leerConfig();

// --- Estaciones: balanzas y escaneres ---------------------------------------
// Cada estacion (puesto de venta) tiene su balanza y su escaner. Un config.json
// viejo con una sola "balanza" se lee como la estacion "Mostrador 1".
const estaciones = new Estaciones(config);

// --- HTTP -------------------------------------------------------------------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// --- Copia a Google Sheets (transicion) ------------------------------------
const sheets = crearSheets(config);
// Gastos por proveedor: se leen de la misma planilla (los carga el bot de Telegram).
const gastos = crearGastos(config);
// Ventas de quienes todavia no usan el POS: se importan de la misma planilla
// (sentido inverso a "sheets", que copia las ventas del POS hacia la planilla).
const sheetsImportar = crearSheetsImportar(config);

// Ultima vez que alguien modifico algo por la API (venta, alta de producto...).
// El actualizador automatico no reinicia el POS si hubo movimiento reciente.
let ultimaEscritura = 0;
app.use('/api', (req, _res, next) => {
  if (req.method !== 'GET') ultimaEscritura = Date.now();
  next();
});

app.use('/api', crearApi({ estaciones, guardarConfig, config, sheets, gastos, sheetsImportar }));

app.get('/api/version', (_req, res) => {
  res.json({ ok: true, version: VERSION, iniciado: INICIADO, deploy: leerEstadoDeploy() });
});

// Para el actualizador automatico (solo desde la misma PC): ¿se puede reiniciar
// el POS ahora? No, si algun equipo tiene articulos en el carrito o si hubo
// uso en los ultimos "segundos" (toques en la pantalla o escrituras a la API).
app.get('/api/deploy/ocupado', (req, res) => {
  const ip = req.socket.remoteAddress || '';
  if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip)) {
    return res.status(403).json({ ok: false, error: 'Solo desde la PC del POS' });
  }
  const n = Number(req.query.segundos);
  const segundos = req.query.segundos !== undefined && Number.isFinite(n) ? Math.max(0, n) : 60;
  const desde = Date.now() - segundos * 1000;
  const motivos = [];
  for (const c of wss.clients) {
    if (c.readyState !== 1 || c.todo) continue;
    const nombre = (estaciones.estacionOPrimera(c.estacion) || {}).nombre || 'un equipo';
    if (c.items > 0) motivos.push(`${nombre}: carrito con ${c.items} artículo(s)`);
    else if (c.tocadoEn && c.tocadoEn > desde) motivos.push(`${nombre}: en uso hace menos de ${segundos} s`);
  }
  if (ultimaEscritura > desde) motivos.push(`cambios por la API hace menos de ${segundos} s`);
  res.json({ ok: true, ocupado: motivos.length > 0, motivos });
});

// Direcciones para entrar desde otro equipo (celular, otra PC). Cuando el POS
// corre como tarea de fondo no hay consola visible, asi que se muestran en admin.
app.get('/api/red', (_req, res) => {
  const puerto = config.http.port || 3000;
  const ips = ipsLocales();
  res.json({
    ok: true,
    puerto,
    direcciones: ips.filter((x) => !x.virtual).map((x) => `http://${x.ip}:${puerto}`),
    adaptadores: ips.map((x) => ({ ...x, url: `http://${x.ip}:${puerto}` })),
  });
});

app.get('/api/config', (req, res) => {
  // "balanza" = la de la estacion pedida (o la primera): compatibilidad con
  // las pantallas y pruebas que conocen una sola balanza.
  const est = estaciones.estacionOPrimera(req.query.estacion);
  const b = est && est.balanza ? estaciones.configBalanza(est.balanza) : null;
  res.json({
    ok: true,
    config: { venta: config.venta, balanza: b, estaciones: estaciones.resumenEstaciones() },
  });
});

// La UI es estatica, pero SIN cache larga: con una hora de cache la tablet se
// quedaba con un index.html viejo y un pos.js nuevo (o al reves) y la pantalla
// rompia. Son archivos chicos en red local; el ETag hace que la revalidacion
// devuelva 304 y no pese nada.
app.use(express.static(path.join(RAIZ, 'public'), {
  maxAge: 0,
  etag: true,
  lastModified: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.use((req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ ok: false, error: 'No encontrado' });
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(RAIZ, 'public', 'index.html'));
});

const server = http.createServer(app);

// --- WebSocket: peso y escaneos por estacion ---------------------------------
// Cada equipo de venta se conecta con /ws?estacion=<id> y recibe solo el peso
// de la balanza y los codigos del escaner de su estacion. Administracion se
// conecta con /ws?todo=1 y recibe todo, marcado con el id del equipo.
const wss = new WebSocketServer({ server, path: '/ws' });

function enviar(ws, payload) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(payload)); } catch (_) { /* se fue */ }
  }
}

function clientesDeEstacion(estId) {
  const out = [];
  for (const c of wss.clients) if (c.readyState === 1 && c.estacion === estId) out.push(c);
  return out;
}

function clientesAdmin() {
  const out = [];
  for (const c of wss.clients) if (c.readyState === 1 && c.todo) out.push(c);
  return out;
}

estaciones.on('balanza', (id, estado) => {
  const msg = { tipo: 'balanza', balanza: id, estado };
  for (const e of estaciones.estacionesConBalanza(id)) {
    for (const c of clientesDeEstacion(e.id)) enviar(c, msg);
  }
  for (const c of clientesAdmin()) enviar(c, msg);
});

estaciones.on('escaner', (id, estado) => {
  const msg = { tipo: 'escaner', escaner: id, estado };
  for (const e of estaciones.estacionesConEscaner(id)) {
    for (const c of clientesDeEstacion(e.id)) enviar(c, msg);
  }
  for (const c of clientesAdmin()) enviar(c, msg);
});

// Un codigo leido va a UN solo equipo de la estacion: el ultimo que se uso
// (toque o tecla). Si hubiera tablet y celular en el mismo puesto, el producto
// no se agrega dos veces.
estaciones.on('codigo', (id, codigo) => {
  let entregado = false;
  for (const e of estaciones.estacionesConEscaner(id)) {
    const cands = clientesDeEstacion(e.id);
    if (!cands.length) continue;
    cands.sort((a, b) => (b.activoEn || 0) - (a.activoEn || 0));
    enviar(cands[0], { tipo: 'escaneo', escaner: id, codigo });
    entregado = true;
  }
  if (!entregado) console.log(`  [escaner ${id}] código ${codigo} leído sin ningún equipo en su estación`);
  for (const c of clientesAdmin()) enviar(c, { tipo: 'escaneo', escaner: id, codigo, entregado });
});

function saludar(ws) {
  if (ws.todo) {
    enviar(ws, { tipo: 'version', version: VERSION.commit });
    for (const d of estaciones.balanzas.values()) enviar(ws, { tipo: 'balanza', balanza: d.id, estado: d.snapshot() });
    for (const d of estaciones.escaneres.values()) enviar(ws, { tipo: 'escaner', escaner: d.id, estado: d.snapshot() });
    return;
  }
  const est = estaciones.estacionOPrimera(ws.estacionPedida);
  ws.estacion = est ? est.id : null;
  enviar(ws, { tipo: 'estacion', estacion: est || null });
  enviar(ws, { tipo: 'version', version: VERSION.commit });
  const b = estaciones.estadoBalanzaDeEstacion(ws.estacion);
  enviar(ws, { tipo: 'balanza', balanza: b.id, estado: b });
  enviar(ws, { tipo: 'escaner', escaner: est && est.escaner, estado: estaciones.estadoEscanerDeEstacion(ws.estacion) });
}

// Si administracion cambia las estaciones, cada equipo recibe su estado nuevo
// (su estacion puede haber cambiado de balanza o haber desaparecido).
estaciones.on('cambio', () => {
  for (const c of wss.clients) if (c.readyState === 1) saludar(c);
});

wss.on('connection', (ws, req) => {
  let q;
  try { q = new URL(req.url, 'http://x').searchParams; } catch (_) { q = new URLSearchParams(); }
  ws.todo = q.get('todo') === '1';
  ws.estacionPedida = q.get('estacion') || null;
  ws.activoEn = Date.now();
  saludar(ws);

  ws.on('message', (data) => {
    let m;
    try { m = JSON.parse(data.toString()); } catch (_) { return; }
    if (!m) return;
    if (m.tipo === 'activo') ws.activoEn = ws.tocadoEn = Date.now();
    // Cuantos articulos tiene el carrito de ese equipo (vive en el navegador).
    else if (m.tipo === 'carrito') ws.items = Math.max(0, Number(m.items) || 0);
  });
  ws.on('error', () => { /* el cliente se fue, no es un problema */ });
});

// Keepalive: si la tablet se suspende, limpiamos la conexion muerta.
const pingTimer = setInterval(() => {
  for (const cliente of wss.clients) {
    if (cliente.readyState === 1) {
      try { cliente.ping(); } catch (_) { /* ignorado */ }
    }
  }
}, 30000);

// --- Arranque ---------------------------------------------------------------
// Adaptadores que no son la red del local: maquinas virtuales, WSL, VPN, etc.
const ADAPTADOR_VIRTUAL = /vethernet|virtualbox|vmware|hyper-v|wsl|loopback|docker|tailscale|zerotier|hamachi|vpn|bluetooth/i;

// IPs por las que se puede entrar desde otro equipo, la red real primero.
function ipsLocales() {
  const out = [];
  for (const [nombre, ifaces] of Object.entries(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family !== 'IPv4' && i.family !== 4) continue;
      if (i.internal || i.address.startsWith('169.254.')) continue; // 169.254 = sin DHCP, no sirve
      out.push({ ip: i.address, adaptador: nombre, virtual: ADAPTADOR_VIRTUAL.test(nombre) });
    }
  }
  return out.sort((a, b) => a.virtual - b.virtual);
}

estaciones.iniciar();
sheets.iniciar();
sheetsImportar.iniciar();

const puerto = config.http.port || 3000;
server.listen(puerto, config.http.host || '0.0.0.0', () => {
  console.log('');
  console.log('  Balanza POS iniciado');
  console.log('  ---------------------------------------------');
  for (const e of estaciones.resumenEstaciones()) {
    const b = e.balanza ? estaciones.configBalanza(e.balanza) : null;
    const modo = !b ? 'sin balanza' : b.simulador ? `${b.nombre} SIMULADOR` : `${b.nombre} ${b.numeroSerie ? 'serie ' + b.numeroSerie : b.puerto}`;
    console.log(`  ${e.nombre}: ${modo}${e.escanerNombre ? ' + ' + e.escanerNombre : ''}`);
  }
  console.log(`  En la PC: http://localhost:${puerto}`);
  for (const x of ipsLocales().filter((i) => !i.virtual)) {
    console.log(`  Tablet:   http://${x.ip}:${puerto}   (${x.adaptador})`);
  }
  console.log(`  Admin:    http://localhost:${puerto}/admin.html`);
  console.log(`  Sheets:   ${sheets.habilitado() ? 'copiando ventas a Google Sheets' : 'apagado'}`);
  console.log(`  Importar: ${sheetsImportar.habilitado() ? 'trayendo ventas de la planilla' : 'apagado'}`);
  console.log(`  Versión:  ${VERSION.corto}${VERSION.fecha ? ' (' + VERSION.fecha + ')' : ''}`);
  console.log('  ---------------------------------------------');
  console.log('');
});

function cerrar() {
  clearInterval(pingTimer);
  sheets.detener();
  sheetsImportar.detener();
  estaciones.detener();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', cerrar);
process.on('SIGTERM', cerrar);
