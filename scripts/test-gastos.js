'use strict';

/**
 * Prueba de los gastos por proveedor (Administracion -> Ventas):
 *   - agrupado por proveedor, pagado / a pagar, centavos, orden
 *   - apps-script-pos/Codigo.gs (leerGastosPos_) corrido con una planilla
 *     simulada: hoja del mes, hoja anual, hoja mensual sin archivar, celdas
 *     con fecha/hora como Date, filas de otro mes o de clientes
 *   - GET /api/gastos contra un webapp simulado (con el 302 de Apps Script):
 *     mes por defecto, memoria, ?refrescar=1, token invalido, version vieja
 *     del webapp, Google caido con y sin lectura anterior, sin configurar
 *
 * No toca Google ni la base real: config y base temporales, puerto 3059.
 *
 *   npm run test-gastos
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { spawn } = require('child_process');
const { agrupar } = require('../src/gastos');

const RAIZ = path.join(__dirname, '..');
const PUERTO = 3059;
const URL = `http://localhost:${PUERTO}`;
const TOKEN = 'token-de-prueba-gastos';
const TZ = 'America/Argentina/Buenos_Aires';
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
    ['2026-09-02', '09:00', 'Coca', -12000, true],
    // Sheets convierte el texto en Date: 03/09 10:15 hora de Argentina
    [new Date('2026-09-03T13:15:00Z'), new Date('2026-09-03T13:15:00Z'), 'coca', -3000.5, true],
    ['2026-09-04', '10:00', 'DP(Paladini)', -20000, false],
    ['2026-09-05', '11:00', 'juanperez', -1500, true],     // gasto personal: el bot guarda el usuario
    ['2026-09-06', '12:00', 'desperdicio', -750, true],
    ['', '', '', '', ''],
    ['2026-08-31', '23:00', 'Coca', -999, true],            // de otro mes, pegada a mano
  ]),
  hoja('2026', [ENC,
    ['2026-08-10', '10:00', 'Coca', -4000, true],
    ['2026-08-11', '10:00', 'cliente', 100, true],
  ]),
  hoja('2026-07', [ENC, ['2026-07-05', '09:00', 'Disbe', -800, 'TRUE']]), // mensual sin archivar
  hoja('2025', [ENC, ['2025-09-02', '09:00', 'Coca', -1, true]]),
  hoja('proveedores', [['Proveedor'], ['Coca'], ['DP(Paladini)'], ['Disbe']]),
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
  // Las fechas tienen que ser Date del mismo "mundo" que el script (instanceof Date).
  const fechaDelScript = vm.runInContext('(function (t) { return new Date(t); })', ctx);
  for (const h of HOJAS) {
    const filas = h.getDataRange().getValues();
    for (const f of filas) for (let i = 0; i < f.length; i++) if (f[i] instanceof Date) f[i] = fechaDelScript(f[i].getTime());
    h.getDataRange = () => ({ getValues: () => filas.map((f) => f.slice()) });
  }
  vm.runInContext(fs.readFileSync(path.join(RAIZ, 'apps-script-pos', 'Codigo.gs'), 'utf8'), ctx);
  return ctx;
}

// --- Webapp simulado (como Apps Script: POST -> 302 -> GET con la respuesta) --

function crearWebapp(gs) {
  const w = { pedidos: 0, modo: 'normal', respuestas: new Map(), n: 0, demora: 0 };
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
      setTimeout(() => {
        res.writeHead(302, { Location: `http://localhost:${w.puerto}${ruta}` });
        res.end();
      }, w.demora || 0);
    });
  });
  return new Promise((r) => w.server.listen(0, () => { w.puerto = w.server.address().port; r(w); }));
}

(async function main() {
  console.log('\n1. Agrupado por proveedor');
  {
    const a = agrupar([
      { fecha: '2026-09-02', hora: '09:00', detalle: 'Coca', monto: 12000, pagado: true },
      { fecha: '2026-09-03', hora: '10:15', detalle: 'coca ', monto: 3000.5, pagado: true },
      { fecha: '2026-09-04', hora: '10:00', detalle: 'DP(Paladini)', monto: 20000, pagado: false },
      { fecha: '2026-09-05', hora: '11:00', detalle: 'juanperez', monto: 1500, pagado: true },
      { fecha: '2026-09-06', hora: '11:00', detalle: '', monto: 10, pagado: true },
      { fecha: '2026-09-06', hora: '11:00', detalle: 'Coca', monto: 0, pagado: true },
    ], ['Coca', 'DP(Paladini)']);
    chequear('total pagado en centavos', a.total_pagado_centavos === 1650050, a.total_pagado_centavos);
    chequear('a pagar aparte', a.total_a_pagar_centavos === 2000000, a.total_a_pagar_centavos);
    chequear('sin detalle o sin monto no cuenta', a.cantidad === 4, a.cantidad);
    chequear('Coca y "coca " son el mismo proveedor', a.proveedores.filter((p) => /coca/i.test(p.nombre)).length === 1);
    const coca = a.proveedores.find((p) => p.nombre === 'Coca');
    chequear('Coca: 2 movimientos, $15.000,50', coca && coca.cantidad === 2 && coca.pagado_centavos === 1500050);
    chequear('movimientos del más reciente al más viejo', coca && coca.movimientos[0].fecha === '2026-09-03');
    chequear('orden: proveedores de la lista primero, mayor gasto arriba',
      a.proveedores.map((p) => p.nombre).join(',') === 'DP(Paladini),Coca,juanperez', a.proveedores.map((p) => p.nombre).join(','));
    chequear('fuera de la lista queda marcado', a.proveedores[2].es_proveedor === false);
  }

  console.log('\n2. Apps Script (Codigo.gs → leerGastosPos_)');
  const gs = cargarAppsScript();
  const pedir = (d) => JSON.parse(gs.doPost({ postData: { contents: JSON.stringify(d) } }).texto);
  {
    const r = pedir({ accion: 'gastos', token: TOKEN, mes: '2026-09' });
    chequear('responde ok con gastos y proveedores', r.ok && Array.isArray(r.gastos) && r.proveedores.length === 3);
    chequear('solo gastos de septiembre (sin clientes ni otros meses)', r.gastos.length === 5, r.gastos.length);
    const d = r.gastos.find((g) => g.detalle === 'coca');
    chequear('celda Date → fecha y hora de Argentina', d && d.fecha === '2026-09-03' && d.hora === '10:15', d && `${d.fecha} ${d.hora}`);
    chequear('monto en positivo', r.gastos.every((g) => g.monto > 0));
    chequear('a pagar = pagado false', r.gastos.find((g) => g.detalle === 'DP(Paladini)').pagado === false);
    const ago = pedir({ accion: 'gastos', token: TOKEN, mes: '2026-08' });
    chequear('agosto sale de la hoja anual (sin la fila pegada en la de septiembre)',
      ago.gastos.length === 1 && ago.gastos[0].monto === 4000, JSON.stringify(ago.gastos));
    const jul = pedir({ accion: 'gastos', token: TOKEN, mes: '2026-07' });
    chequear('hoja mensual sin archivar y "TRUE" como texto', jul.gastos.length === 1 && jul.gastos[0].pagado === true);
    chequear('token inválido → rechaza', pedir({ accion: 'gastos', token: 'x', mes: '2026-09' }).error === 'token invalido');
    chequear('mes inválido → rechaza', pedir({ accion: 'gastos', token: TOKEN, mes: '2026-9' }).error === 'mes invalido');
    chequear('un envío de ventas sigue yendo por el camino de siempre',
      pedir({ origen: 'pos', token: 'x', ventas: [] }).error === 'token invalido');
  }

  console.log('\n3. GET /api/gastos (webapp simulado)');
  const w = await crearWebapp(gs);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-gastos-'));
  const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.example.json'), 'utf8'));
  cfg.http.port = PUERTO;
  for (const b of cfg.balanzas) b.simulador = true;
  cfg.sheets = { habilitado: false, url: `http://localhost:${w.puerto}/exec`, token: TOKEN };
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
  const get = (ruta) => fetch(URL + ruta).then((r) => r.json());

  try {
    await levantar();
    let d = await get('/api/gastos?mes=2026-09');
    let g = d.gastos;
    chequear('habilitado sin la copia de ventas (alcanza url + token)', d.ok && g.habilitado === true, JSON.stringify(g).slice(0, 120));
    chequear('pide la acción gastos con el token', w.ultimo && w.ultimo.accion === 'gastos' && w.ultimo.token === TOKEN && w.ultimo.mes === '2026-09');
    chequear('total pagado $17.250,50', g.total_pagado_centavos === 1725050, g.total_pagado_centavos);
    chequear('a pagar $20.000', g.total_a_pagar_centavos === 2000000, g.total_a_pagar_centavos);
    chequear('4 filas: DP, Coca, juanperez, desperdicio',
      g.proveedores.map((p) => p.nombre).join(',') === 'DP(Paladini),Coca,juanperez,desperdicio', g.proveedores.map((p) => p.nombre).join(','));
    chequear('nombre como está en la lista ("coca" → "Coca")', g.proveedores[1].nombre === 'Coca' && g.proveedores[1].cantidad === 2);
    chequear('trae la hora de lectura', !!g.actualizado);

    const antes = w.pedidos;
    d = await get('/api/gastos?mes=2026-09');
    chequear('segunda vez sale de memoria (no va a Google)', w.pedidos === antes && d.gastos.total_pagado_centavos === 1725050, `${antes} -> ${w.pedidos}`);
    d = await get('/api/gastos?mes=2026-09&refrescar=1');
    chequear('?refrescar=1 vuelve a leer', w.pedidos === antes + 1);
    w.demora = 400; // Google tarda: el segundo pedido llega mientras el primero sigue en curso
    const [x1, x2] = await Promise.all([get('/api/gastos?mes=2026-07&refrescar=1'), get('/api/gastos?mes=2026-07&refrescar=1')]);
    chequear('dos pedidos juntos → una sola lectura', w.pedidos === antes + 2 && x1.gastos.total_pagado_centavos === 80000 && x2.gastos.total_pagado_centavos === 80000,
      `${w.pedidos - antes} lecturas, ${x1.gastos.total_pagado_centavos}/${x2.gastos.total_pagado_centavos}`);
    w.demora = 0;

    d = await get('/api/gastos');
    const mesActual = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
    chequear('sin ?mes → mes en curso', d.gastos.mes === mesActual, d.gastos.mes);
    d = await get('/api/gastos?mes=2026-13');
    chequear('mes inválido → mes en curso', d.gastos.mes === mesActual);

    w.modo = 'vieja';
    d = await get('/api/gastos?mes=2026-06');
    chequear('webapp sin publicar → avisa que falta la versión nueva',
      d.ok && d.gastos.codigo === 'version-vieja' && /versión nueva/.test(d.gastos.error), d.gastos.error);
    w.modo = 'normal';

    await new Promise((r) => w.server.close(r));
    d = await get('/api/gastos?mes=2026-09&refrescar=1');
    chequear('Google caído con lectura anterior → la muestra con aviso',
      d.gastos.desactualizado === true && d.gastos.total_pagado_centavos === 1725050 && !!d.gastos.error, d.gastos.error);
    d = await get('/api/gastos?mes=2026-05');
    chequear('Google caído sin lectura anterior → error, sin romper', d.ok && !!d.gastos.error && !d.gastos.proveedores, d.gastos.error);

    // Token equivocado
    servidor.kill();
    await esperar(400);
    await new Promise((r) => w.server.listen(w.puerto, r));
    cfg.sheets.token = 'otro';
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
    servidor = spawn(process.execPath, [path.join(RAIZ, 'src', 'server.js')], { stdio: ['ignore', 'ignore', 'inherit'], env });
    await levantar();
    d = await get('/api/gastos?mes=2026-09');
    chequear('token distinto de POS_TOKEN → lo dice', /token/.test(d.gastos.error || ''), d.gastos.error);

    // Sin token: apagado
    servidor.kill();
    await esperar(400);
    cfg.sheets.token = '';
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
    servidor = spawn(process.execPath, [path.join(RAIZ, 'src', 'server.js')], { stdio: ['ignore', 'ignore', 'inherit'], env });
    await levantar();
    const n = w.pedidos;
    d = await get('/api/gastos?mes=2026-09');
    chequear('sin token → habilitado false, no va a Google', d.ok && d.gastos.habilitado === false && w.pedidos === n);
  } catch (e) {
    console.error(e);
    fallos++;
  }

  console.log(fallos ? `\n${fallos} verificación(es) fallaron\n` : '\nTodo OK\n');
  terminar(fallos ? 1 : 0);
})();
