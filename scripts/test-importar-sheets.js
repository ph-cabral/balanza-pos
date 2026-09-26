'use strict';

/**
 * Prueba de la importacion de ventas desde la planilla (Administracion ->
 * Ventas, panel "Importación desde la planilla"):
 *   - conClaves(): deduplicacion por fecha+hora+monto, con ventas iguales en
 *     el mismo minuto (n-esima ocurrencia)
 *   - apps-script-pos/Codigo.gs (leerVentasPos_) corrido con una planilla
 *     simulada: hoja del mes, hoja anual, hoja mensual sin archivar, filas de
 *     gastos (se descartan), celdas Date, monto 0 o vacio
 *   - POST /api/sheets/importar/ahora y GET /api/sheets/importar/estado
 *     contra un webapp simulado (con el 302 de Apps Script): primera corrida
 *     trae toda la planilla, la segunda no duplica nada, token invalido,
 *     version vieja del webapp, Google caido
 *   - la venta importada queda en SQLite con origen 'sheet' y un item
 *     generico con el total
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
const { conClaves } = require('../src/sheets-importar');

const RAIZ = path.join(__dirname, '..');
const PUERTO = 3060;
const URL = `http://localhost:${PUERTO}`;
const TOKEN = 'token-de-prueba-ventas';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let fallos = 0;
function chequear(desc, cond, detalle) {
  if (!cond) fallos++;
  console.log(`  ${cond ? 'OK  ' : 'MAL '} ${desc}${detalle !== undefined ? '  -> ' + detalle : ''}`);
}

// --- Planilla simulada para Codigo.gs ---------------------------------------

function hoja(nombre, filas) {
  return {
    getName: () => nombre,
    getDataRange: () => ({ getValues: () => filas.map((f) => f.slice()) }),
  };
}

const ENC = ['Fecha', 'Hora', 'Proveedor', 'Monto', 'Pagado'];
const HOJAS = [
  hoja('2026-09', [ENC,
    ['2026-09-01', '08:10', 'cliente', 5000, true],
    ['2026-09-01', '08:10', 'cliente', 5000, true],   // misma fecha/hora/monto: dos ventas distintas
    ['2026-09-02', '09:00', 'Coca', -12000, true],     // gasto: no es una venta
    ['2026-09-06', '12:00', 'cliente', 0, true],       // monto 0: se descarta
    ['', '', '', '', ''],
  ]),
  hoja('2026', [
    ENC,
    ['2026-08-10', '10:00', 'cliente', 4000, true],
  ]),
  hoja('2026-07', [ENC, ['2026-07-05', '09:00', 'cliente', 800, true]]), // mensual sin archivar
  hoja('proveedores', [['Proveedor'], ['Coca']]),
];

function cargarAppsScript() {
  const ctx = {
    console,
    SpreadsheetApp: {
      openById: () => ({
        getSheets: () => HOJAS,
        getSheetByName: (n) => HOJAS.find((h) => h.getName() === n) || null,
      }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'POS_TOKEN' ? TOKEN : null) }) },
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
    Logger: { log() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(RAIZ, 'apps-script-pos', 'Codigo.gs'), 'utf8'), ctx);
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
      if (w.modo === 'vieja') {
        txt = JSON.stringify({ ok: true, aceptadas: [], rechazadas: [], telegram: 'sin ventas nuevas' });
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
  console.log('\n1. conClaves(): deduplicacion');
  {
    const c = conClaves([
      { fecha: '2026-09-01', hora: '08:10', monto: 50 },
      { fecha: '2026-09-01', hora: '08:10', monto: 50 },
      { fecha: '2026-09-01', hora: '08:10', monto: 60 },
    ]);
    chequear('centavos correctos', c[0].total_centavos === 5000);
    chequear('dos iguales -> claves distintas (n-esima ocurrencia)', c[0].clave !== c[1].clave, `${c[0].clave} / ${c[1].clave}`);
    chequear('distinto monto -> clave distinta de las anteriores', c[2].clave !== c[0].clave && c[2].clave !== c[1].clave);
    chequear('misma entrada, mismo orden -> mismas claves (estable entre lecturas)',
      conClaves([{ fecha: '2026-09-01', hora: '08:10', monto: 50 }, { fecha: '2026-09-01', hora: '08:10', monto: 50 }])
        .map((x) => x.clave).join(',') === c.slice(0, 2).map((x) => x.clave).join(','));
  }

  console.log('\n2. Apps Script (Codigo.gs -> leerVentasPos_)');
  const gs = cargarAppsScript();
  const pedir = (d) => JSON.parse(gs.doPost({ postData: { contents: JSON.stringify(d) } }).texto);
  {
    const r = pedir({ accion: 'ventas', token: TOKEN });
    chequear('responde ok con la lista de ventas', r.ok && Array.isArray(r.ventas));
    chequear('4 ventas "cliente" en toda la planilla (sin el gasto ni el monto 0)', r.ventas.length === 4, r.ventas.length);
    chequear('trae la del mes sin archivar y la del anio', r.ventas.some((v) => v.fecha === '2026-07-05') && r.ventas.some((v) => v.fecha === '2026-08-10'));
    chequear('ordenadas por fecha y hora', r.ventas.every((v, i) => i === 0 || (r.ventas[i - 1].fecha + r.ventas[i - 1].hora) <= (v.fecha + v.hora)));
    chequear('token invalido -> rechaza', pedir({ accion: 'ventas', token: 'x' }).error === 'token invalido');
  }

  console.log('\n3. POST /api/sheets/importar/ahora (webapp simulado)');
  const w = await crearWebapp(gs);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-importar-'));
  const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.example.json'), 'utf8'));
  cfg.http.port = PUERTO;
  for (const b of cfg.balanzas) b.simulador = true;
  cfg.sheets = { habilitado: false, importar: true, importarSegundos: 999999, url: `http://localhost:${w.puerto}/exec`, token: TOKEN };
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
  const post = (ruta) => fetch(URL + ruta, { method: 'POST' }).then((r) => r.json());
  const get = (ruta) => fetch(URL + ruta).then((r) => r.json());

  try {
    await levantar();

    // El arranque ya dispara una corrida sola (iniciar() llama a procesar()); esperamos que termine.
    await esperar(300);
    let d = await get('/api/sheets/importar/estado');
    chequear('arranca solo y trae toda la planilla (4 ventas)', d.importar.habilitado && d.importar.importadas === 4, JSON.stringify(d.importar));
    chequear('pide la accion ventas con el token', w.ultimo && w.ultimo.accion === 'ventas' && w.ultimo.token === TOKEN);

    d = await post('/api/sheets/importar/ahora');
    chequear('correr de nuevo no duplica nada', d.importar.importadas === 4, d.importar.importadas);

    const recientes = await get('/api/ventas?limite=10');
    const importada = recientes.ventas.find((v) => v.origen === 'sheet');
    chequear('las ventas importadas quedan con origen sheet', !!importada);
    const detalle = await get(`/api/ventas/${importada.id}`);
    chequear('item generico con el total (sin detalle de la planilla)',
      detalle.venta.items.length === 1 && detalle.venta.items[0].subtotal_centavos === detalle.venta.total_centavos);

    w.modo = 'vieja';
    d = await post('/api/sheets/importar/ahora');
    chequear('webapp sin publicar -> avisa que falta la version nueva',
      d.importar.ultimo_resultado.codigo === 'version-vieja', JSON.stringify(d.importar.ultimo_resultado));
    w.modo = 'normal';

    await new Promise((r) => w.server.close(r));
    d = await post('/api/sheets/importar/ahora');
    chequear('Google caido -> error sin romper, sigue con lo ya importado', d.importar.ultimo_resultado.ok === false && d.importar.importadas === 4);

    servidor.kill();
    await esperar(400);
    await new Promise((r) => w.server.listen(w.puerto, r));
    cfg.sheets.token = 'otro';
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
    servidor = spawn(process.execPath, [path.join(RAIZ, 'src', 'server.js')], { stdio: ['ignore', 'ignore', 'inherit'], env });
    await levantar();
    await esperar(300);
    d = await get('/api/sheets/importar/estado');
    chequear('token distinto de POS_TOKEN -> lo dice', /token/.test((d.importar.ultimo_resultado || {}).error || ''), JSON.stringify(d.importar.ultimo_resultado));

    console.log(`\n${fallos === 0 ? 'Todo OK' : fallos + ' fallo(s)'}`);
    terminar(fallos === 0 ? 0 : 1);
  } catch (e) {
    console.error(e);
    terminar(1);
  }
})();
