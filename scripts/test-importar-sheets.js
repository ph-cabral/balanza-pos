'use strict';

/**
 * Prueba de la copia de la planilla de Google a SQLite (Administracion ->
 * Ventas, panel "Copia de la planilla en esta base"):
 *   - normalizar(): montos a centavos, hora vacia, filas sin fecha
 *   - apps-script-pos/Codigo.gs (leerPlanillaPos_) corrido con una planilla
 *     simulada: todas las hojas (anual, mensual, mensual sin archivar), todos
 *     los tipos, montos con signo, celdas Date, lista de proveedores; la
 *     accion vieja 'ventas' sigue respondiendo
 *   - el servidor contra un webapp simulado (con el 302 de Apps Script):
 *       * al arrancar copia la planilla entera en una sola tabla y crea las
 *         ventas del bot (origen 'sheet', item generico), sin duplicar al
 *         releer
 *       * una venta del POS copiada a la planilla NO vuelve como venta del bot
 *       * lo que el bot reclasifica (cliente -> proveedor) o elimina se quita
 *         de las ventas; una fila nueva se agrega
 *       * fila vieja sin hora -> venta a las 00:00
 *       * version vieja del webapp, planilla sin hojas de meses, Google caido
 *         y token invalido: error sin tocar la copia
 *
 * No toca Google ni la base real: config y base temporales, puerto 3060.
 *
 *   npm run test-importar-sheets
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn } = require('child_process');
const { normalizar } = require('../src/sheets-importar');

const RAIZ = path.join(__dirname, '..');
const PUERTO = 3060;
const URL = `http://localhost:${PUERTO}`;
const TOKEN = 'token-de-prueba-ventas';
const TZ = 'America/Argentina/Buenos_Aires';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let fallos = 0;
function chequear(desc, cond, detalle) {
  if (!cond) fallos++;
  console.log(`  ${cond ? 'OK  ' : 'MAL '} ${desc}${detalle !== undefined ? '  -> ' + detalle : ''}`);
}

// --- Planilla simulada (se puede escribir: el POS copia sus ventas) --------

function hoja(nombre, filas) {
  return {
    filas,
    getName: () => nombre,
    getDataRange: () => ({ getValues: () => filas.map((f) => f.slice()) }),
    appendRow: (f) => { filas.push(f.slice()); },
    getLastRow: () => filas.length,
    setColumnWidth() {},
    setFrozenRows() {},
    getRange: () => ({ setValues() { return this; }, setFontWeight() { return this; }, setBackground() { return this; }, setFontColor() { return this; } }),
  };
}

const ENC = ['Fecha', 'Hora', 'Proveedor', 'Monto', 'Pagado'];
const MES_ACTUAL = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
const HOY = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

let HOJAS = [
  hoja(MES_ACTUAL, [ENC,
    [`${MES_ACTUAL}-01`, '08:10', 'cliente', 5000, true],
    [`${MES_ACTUAL}-01`, '08:10', 'cliente', 5000, true],   // misma fecha/hora/monto: dos ventas distintas
    [`${MES_ACTUAL}-02`, '09:00', 'Coca', -12000, true],     // gasto
    [`${MES_ACTUAL}-02`, '09:30', 'cliente', 7000, true],    // el bot la va a reclasificar
    [`${MES_ACTUAL}-03`, '10:00', 'cliente', 900, true],     // el bot la va a eliminar
    [`${MES_ACTUAL}-04`, '11:00', 'DP(Paladini)', -20000, false],
    [`${MES_ACTUAL}-06`, '12:00', 'cliente', 0, true],       // monto 0: no es venta
    ['', '', '', '', ''],
  ]),
  hoja('2025', [ENC,
    ['2025-05-17', '', 'cliente', 2400, true],                // fila vieja sin hora
    ['2025-06-10', '10:00', 'cliente', 4000, true],
  ]),
  hoja('2025-12', [ENC, ['2025-12-05', '09:00', 'cliente', 800, true]]), // mensual sin archivar
  hoja('proveedores', [['Proveedor'], ['Coca'], ['DP(Paladini)']]),
  hoja('config', [['x'], ['y']]), // otra hoja: se ignora
];

function cargarAppsScript() {
  const props = new Map([['POS_TOKEN', TOKEN]]);
  const ss = {
    getSheets: () => HOJAS,
    getSheetByName: (n) => HOJAS.find((h) => h.getName() === n) || null,
    insertSheet: (n) => { const h = hoja(n, []); HOJAS.push(h); return h; },
    deleteSheet: (h) => { HOJAS = HOJAS.filter((x) => x !== h); },
  };
  const ctx = {
    console,
    SpreadsheetApp: { openById: () => ss },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props.get(k) || null, setProperty: (k, v) => props.set(k, v) }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: {
      formatDate(d, tz, fmt) {
        const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).formatToParts(d).map((x) => [x.type, x.value]));
        return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute);
      },
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (texto) => ({ texto, setMimeType() { return this; } }),
    },
    UrlFetchApp: { fetch() { throw new Error('sin red'); } },
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(RAIZ, 'apps-script-pos', 'Codigo.gs'), 'utf8'), ctx);
  ctx.fechaDelScript = vm.runInContext('(function (t) { return new Date(t); })', ctx);
  return ctx;
}

// --- Webapp simulado (como Apps Script: POST -> 302 -> GET con la respuesta) --

function crearWebapp(gs) {
  const w = { pedidos: 0, modo: 'normal', respuestas: new Map(), n: 0 };
  w.server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/respuesta/')) {
      const txt = w.respuestas.get(req.url) || '{}';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(txt);
    }
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; });
    req.on('end', () => {
      w.pedidos++;
      w.ultimo = JSON.parse(cuerpo);
      let txt;
      if (w.modo === 'vieja' && w.ultimo.accion === 'planilla') {
        txt = JSON.stringify({ ok: true, aceptadas: [], rechazadas: [], telegram: 'sin ventas nuevas' });
      } else if (w.modo === 'sin-hojas' && w.ultimo.accion === 'planilla') {
        txt = JSON.stringify({ ok: true, hojas: 0, movimientos: [], proveedores: [] });
      } else {
        txt = gs.doPost({ postData: { contents: cuerpo } }).texto;
      }
      const ruta = `/respuesta/${++w.n}`;
      w.respuestas.set(ruta, txt);
      res.writeHead(302, { Location: `http://localhost:${w.puerto}${ruta}` });
      res.end();
    });
  });
  return new Promise((r) => w.server.listen(0, () => { w.puerto = w.server.address().port; r(w); }));
}

(async function main() {
  console.log('\n1. normalizar()');
  {
    const n = normalizar([
      { fecha: '2026-09-01', hora: '08:10', tipo: 'cliente', monto: 2561.5, pagado: true },
      { fecha: '2025-05-17', hora: '', tipo: ' Coca ', monto: -12000, pagado: 'TRUE' },
      { fecha: '', hora: '08:00', tipo: 'cliente', monto: 1, pagado: true },
    ]);
    chequear('centavos sin perder los decimales', n[0].monto_centavos === 256150);
    chequear('egreso negativo y "TRUE" como texto', n[1].monto_centavos === -1200000 && n[1].pagado === true && n[1].tipo === 'Coca');
    chequear('hora vacía queda vacía', n[1].hora === '');
    chequear('fila sin fecha se descarta', n.length === 2);
  }

  console.log('\n2. Apps Script (Codigo.gs -> leerPlanillaPos_)');
  const gs = cargarAppsScript();
  // Una celda que Sheets convirtio en Date (fecha y hora de Argentina 13:15 -> 10:15)
  HOJAS[0].filas.push([gs.fechaDelScript(Date.parse(`${MES_ACTUAL}-05T13:15:00Z`)), gs.fechaDelScript(Date.parse(`${MES_ACTUAL}-05T13:15:00Z`)), 'cliente', 3000.5, true]);
  const pedir = (d) => JSON.parse(gs.doPost({ postData: { contents: JSON.stringify(d) } }).texto);
  {
    const r = pedir({ accion: 'planilla', token: TOKEN });
    chequear('responde ok con movimientos y proveedores', r.ok && Array.isArray(r.movimientos) && r.proveedores.join(',') === 'Coca,DP(Paladini)');
    chequear('3 hojas de meses (sin "proveedores" ni "config")', r.hojas === 3, r.hojas);
    chequear('todas las filas de todos los tipos (11, sin la vacía)', r.movimientos.length === 11, r.movimientos.length);
    chequear('egreso con su signo', r.movimientos.some((m) => m.tipo === 'Coca' && m.monto === -12000));
    chequear('a pagar = pagado false', r.movimientos.find((m) => m.tipo === 'DP(Paladini)').pagado === false);
    chequear('celda Date -> fecha y hora de Argentina', r.movimientos.some((m) => m.fecha === `${MES_ACTUAL}-05` && m.hora === '10:15'));
    chequear('ordenadas por fecha y hora', r.movimientos.every((m, i) => i === 0 || (r.movimientos[i - 1].fecha + r.movimientos[i - 1].hora) <= (m.fecha + m.hora)));
    chequear('token invalido -> rechaza', pedir({ accion: 'planilla', token: 'x' }).error === 'token invalido');
    chequear('la accion vieja "ventas" sigue respondiendo', pedir({ accion: 'ventas', token: TOKEN }).ventas.length === 8);
  }

  console.log('\n3. Servidor contra el webapp simulado');
  const w = await crearWebapp(gs);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-importar-'));
  const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.example.json'), 'utf8'));
  cfg.http.port = PUERTO;
  for (const b of cfg.balanzas) b.simulador = true;
  cfg.sheets = { habilitado: true, reintentoSegundos: 999999, importar: true, importarSegundos: 999999,
    url: `http://localhost:${w.puerto}/exec`, token: TOKEN };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));

  const env = { ...process.env, POS_CONFIG: path.join(dir, 'config.json'), POS_DATA: dir, POS_CONFIG_COMUN: path.join(dir, 'no-existe.json') };
  delete env.POS_SIN_SHEETS;
  let servidor = spawn(process.execPath, [path.join(RAIZ, 'src', 'server.js')], { stdio: ['ignore', 'ignore', 'inherit'], env });
  const levantar = async () => {
    for (let i = 0; i < 50; i++) {
      try { await fetch(URL + '/api/red'); return; } catch (_) { await esperar(200); }
    }
  };
  const terminar = (codigo) => {
    try { servidor.kill(); } catch (_) {}
    try { w.server.close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    process.exit(codigo);
  };
  const post = (ruta, cuerpo) => fetch(URL + ruta, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo || {}) }).then((r) => r.json());
  const get = (ruta) => fetch(URL + ruta).then((r) => r.json());
  const estado = async () => {
    for (let i = 0; i < 50; i++) {
      const e = (await get('/api/sheets/importar/estado')).importar;
      if (e.ultimo_intento && !e.en_curso) return e;
      await esperar(100);
    }
    return null;
  };
  const ventasSheet = async () => (await get('/api/ventas?limite=200')).ventas.filter((v) => v.origen === 'sheet');

  try {
    await levantar();
    let e = await estado();
    chequear('arranca solo y copia la planilla entera (11 filas)', e.habilitado && e.movimientos === 11, JSON.stringify({ m: e.movimientos, g: e.gastos, i: e.importadas }));
    chequear('pide la accion planilla con el token', w.ultimo && w.ultimo.accion === 'planilla' && w.ultimo.token === TOKEN);
    chequear('8 ventas del bot (las "cliente" con monto)', e.importadas === 8, e.importadas);
    chequear('2 gastos y 2 proveedores en la lista', e.gastos === 2 && e.proveedores === 2, `${e.gastos} / ${e.proveedores}`);
    chequear('rango de fechas de la copia', e.desde === '2025-05-17' && e.hasta === `${MES_ACTUAL}-06`, `${e.desde} .. ${e.hasta}`);

    let d = await post('/api/sheets/importar/ahora');
    chequear('releer no duplica nada', d.importar.importadas === 8 && d.importar.movimientos === 11 &&
      d.importar.ultimo_resultado.ventas_nuevas === 0 && d.importar.ultimo_resultado.ventas_borradas === 0, JSON.stringify(d.importar.ultimo_resultado));

    let vs = await ventasSheet();
    const sinHora = vs.find((v) => v.fecha.startsWith('2025-05-17'));
    chequear('fila vieja sin hora -> venta a las 00:00', sinHora && sinHora.fecha === '2025-05-17 00:00:00', sinHora && sinHora.fecha);
    const det = await get(`/api/ventas/${vs[0].id}`);
    chequear('item generico con el total', det.venta.items.length === 1 && det.venta.items[0].subtotal_centavos === det.venta.total_centavos);
    chequear('últimas ventas ordenadas por fecha (la más nueva arriba)', vs.every((v, i) => i === 0 || vs[i - 1].fecha >= v.fecha));
    const tot = await get('/api/ventas/totales?mes=2025-12');
    chequear('los totales por mes incluyen las ventas del bot', tot.totalMes.total_centavos === 80000, tot.totalMes.total_centavos);

    // --- Venta del POS: se copia a la planilla y no tiene que volver como venta del bot
    const v = await post('/api/ventas', { items: [{ nombre: 'Prueba', tipo: 'unidad', cantidad: 1, precio_centavos: 500000 }] });
    chequear('venta del POS guardada', v.ok, v.error);
    let copiada = false;
    for (let i = 0; i < 40 && !copiada; i++) {
      await esperar(100);
      copiada = (await get('/api/sheets/estado')).sheets.enviadas === 1;
    }
    chequear('la venta del POS llegó a la planilla simulada', copiada && HOJAS[0].filas.some((f) => f[2] === 'cliente' && f[3] === 5000 && f[0] === HOY));
    // Una venta del bot con la misma fecha, hora y monto que la del POS
    const filaPos = HOJAS[0].filas.find((f) => f[0] === HOY && f[3] === 5000);
    HOJAS[0].filas.push([filaPos[0], filaPos[1], 'cliente', 5000, true]);
    d = await post('/api/sheets/importar/ahora');
    let r = d.importar.ultimo_resultado;
    chequear('la venta del POS no vuelve; la del bot igual a ella sí entra', r.ventas_nuevas === 1 && d.importar.importadas === 9 && d.importar.movimientos === 13, JSON.stringify(r));
    const vPos = (await get('/api/ventas?limite=200')).ventas.filter((x) => x.origen === 'pos');
    chequear('una sola venta del POS en la base', vPos.length === 1);

    // --- El bot reclasifica una venta como proveedor y elimina otra
    const reclas = HOJAS[0].filas.find((f) => f[1] === '09:30');
    reclas[2] = 'Coca'; reclas[3] = -7000;
    HOJAS[0].filas.splice(HOJAS[0].filas.findIndex((f) => f[1] === '10:00' && f[3] === 900), 1);
    HOJAS[0].filas.push([HOY, '23:59', 'cliente', 1234, true]); // venta nueva del bot
    d = await post('/api/sheets/importar/ahora');
    r = d.importar.ultimo_resultado;
    chequear('reclasificada y eliminada se quitan; la nueva se agrega', r.ventas_borradas === 2 && r.ventas_nuevas === 1 && d.importar.importadas === 8,
      JSON.stringify(r) + ' importadas ' + d.importar.importadas);
    chequear('la reclasificada ahora es gasto', d.importar.gastos === 3, d.importar.gastos);
    vs = await ventasSheet();
    chequear('ya no hay venta de $70 ni de $9', !vs.some((x) => x.total_centavos === 700000 || x.total_centavos === 90000));
    const g = await get(`/api/gastos?mes=${MES_ACTUAL}`);
    chequear('gastos del mes desde la copia: Coca $190 pagado, DP $200 a pagar',
      g.gastos.total_pagado_centavos === 1900000 && g.gastos.total_a_pagar_centavos === 2000000, `${g.gastos.total_pagado_centavos} / ${g.gastos.total_a_pagar_centavos}`);

    // --- Errores: la copia local no se toca
    const antes = d.importar.movimientos;
    w.modo = 'vieja';
    d = await post('/api/sheets/importar/ahora');
    chequear('webapp sin publicar -> avisa que falta la version nueva',
      d.importar.ultimo_resultado.codigo === 'version-vieja' && d.importar.movimientos === antes, JSON.stringify(d.importar.ultimo_resultado));
    w.modo = 'sin-hojas';
    d = await post('/api/sheets/importar/ahora');
    chequear('planilla sin hojas de meses -> error, no vacía la copia',
      d.importar.ultimo_resultado.ok === false && d.importar.movimientos === antes && d.importar.importadas === 8, d.importar.ultimo_resultado.error);
    w.modo = 'normal';

    await new Promise((res) => w.server.close(res));
    d = await post('/api/sheets/importar/ahora');
    chequear('Google caido -> error sin romper, sigue la copia', d.importar.ultimo_resultado.ok === false && d.importar.importadas === 8 && d.importar.movimientos === antes);

    servidor.kill();
    await esperar(400);
    await new Promise((res) => w.server.listen(w.puerto, res));
    cfg.sheets.token = 'otro';
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
    servidor = spawn(process.execPath, [path.join(RAIZ, 'src', 'server.js')], { stdio: ['ignore', 'ignore', 'inherit'], env });
    await levantar();
    e = await estado();
    chequear('token distinto de POS_TOKEN -> lo dice', /token/.test((e.ultimo_resultado || {}).error || '') && e.movimientos === antes, JSON.stringify(e.ultimo_resultado));

    console.log(`\n${fallos === 0 ? 'Todo OK' : fallos + ' fallo(s)'}`);
    terminar(fallos === 0 ? 0 : 1);
  } catch (err) {
    console.error(err);
    terminar(1);
  }
})();
