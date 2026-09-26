'use strict';

/**
 * Prueba de estaciones de trabajo: dos balanzas y dos escaneres (simulados)
 * repartidos en dos estaciones.
 *
 * No toca la configuracion ni la base reales: arranca el servidor con una
 * config y una carpeta de datos temporales (POS_CONFIG / POS_DATA) en el
 * puerto 3057, asi que corre aunque el POS este funcionando.
 *
 *   npm run test-estaciones
 *
 * Partes:
 *   1. Migracion de un config.json viejo (una sola "balanza").
 *   2. Eleccion de puertos con dos adaptadores FTDI (serialport simulado).
 *   3. Servidor: cada estacion ve su peso, captura de su balanza, codigos del
 *      escaner a su estacion (y a un solo equipo), ventas con estacion,
 *      validaciones y reasignacion en caliente.
 *   4. Pantalla (si hay Playwright): pregunta la estacion, la recuerda, el
 *      escaner de la estacion carga el producto.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const PUERTO = 3057;
const URL = `http://localhost:${PUERTO}`;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let fallos = 0;
function chequear(desc, cond, detalle) {
  if (!cond) fallos++;
  console.log(`  ${cond ? 'OK  ' : 'MAL '} ${desc}${detalle !== undefined ? '  -> ' + detalle : ''}`);
}

// ---------------------------------------------------------------- 1. migracion

function parteMigracion() {
  console.log('\n1. config.json viejo con una sola balanza');
  const { normalizar, validar } = require('../src/estaciones');
  const viejo = { balanza: { simulador: false, puerto: 'COM4', stopBits: 2, protocolo: 'kretz' } };
  const n = normalizar(viejo);
  chequear('queda una balanza b1 con el puerto de antes', n.balanzas.length === 1 && n.balanzas[0].id === 'b1' && n.balanzas[0].puerto === 'COM4');
  chequear('y una estación "Mostrador 1" que la usa', n.estaciones.length === 1 && n.estaciones[0].nombre === 'Mostrador 1' && n.estaciones[0].balanza === 'b1');
  chequear('sin escáneres', n.escaneres.length === 0);
  chequear('es válida', validar(n).length === 0);

  const dos = normalizar({
    balanzas: [{ id: 'b1', puerto: 'COM4' }, { id: 'b2', puerto: 'COM4' }],
    estaciones: [{ id: 'e1', balanza: 'b1' }, { id: 'e2', balanza: 'b1' }],
  });
  const errs = validar(dos);
  chequear('rechaza dos balanzas en el mismo COM', errs.some((e) => /Puerto repetido/.test(e)));
  chequear('rechaza la misma balanza en dos estaciones', errs.some((e) => /misma balanza/.test(e)));
}

// ---------------------------------------------------------------- 2. puertos

async function partePuertos() {
  console.log('\n2. Elección de puerto con dos adaptadores FTDI (simulados)');
  let lista = [];
  // serialport simulado: solo hace falta list().
  const ruta = require.resolve('serialport');
  require.cache[ruta] = { id: ruta, filename: ruta, loaded: true, exports: { SerialPort: { list: async () => lista } } };
  delete require.cache[require.resolve('../src/puertos')];
  const puertos = require('../src/puertos');

  const ftdi = (path, serie) => ({ path, manufacturer: 'FTDI', serialNumber: serie, vendorId: '0403', productId: '6001' });
  lista = [ftdi('COM7', 'FTAAA111'), ftdi('COM8', 'FTBBB222'), { path: 'COM9', manufacturer: 'Honeywell', serialNumber: 'HW1', vendorId: '0c2e', productId: '0b61' }];

  let r = await puertos.resolver({ dueno: 'b1', cfg: { puerto: 'COM4', numeroSerie: 'FTBBB222' }, tipo: 'balanza' });
  chequear('por número de serie encuentra el adaptador aunque cambie el COM', r.ruta === 'COM8', r.ruta);
  r = await puertos.resolver({ dueno: 'b2', cfg: { puerto: 'COM4', autodeteccion: true }, tipo: 'balanza' });
  chequear('autodetección: queda un solo FTDI libre y lo toma', r.ruta === 'COM7', r.ruta);
  puertos.liberar('b1'); puertos.liberar('b2');

  r = await puertos.resolver({ dueno: 'b3', cfg: { puerto: 'COM4', autodeteccion: true }, tipo: 'balanza' });
  chequear('con dos FTDI libres no adivina', r.ruta === 'COM4', r.ruta);
  r = await puertos.resolver({ dueno: 's1', cfg: { puerto: 'COM5', autodeteccion: true }, tipo: 'escaner' });
  chequear('un escáner no toma el FTDI de una balanza', r.ruta === 'COM9', r.ruta);
  r = await puertos.resolver({ dueno: 'b4', cfg: { puerto: 'COM9' }, tipo: 'balanza' });
  chequear('no abre un puerto que ya usa otro equipo', r.ruta === null && /otro equipo/.test(r.error), r.error);
  r = await puertos.resolver({ dueno: 'b5', cfg: { puerto: 'COM7', numeroSerie: 'NOEXISTE' }, tipo: 'balanza' });
  chequear('si el adaptador de ese número no está, lo dice', r.ruta === null && /NOEXISTE/.test(r.error));
  delete require.cache[ruta];
}

// ---------------------------------------------------------------- 3. servidor

function wsCliente(q) {
  const WebSocket = require('ws');
  const ws = new WebSocket(`ws://localhost:${PUERTO}/ws${q}`);
  ws.msgs = [];
  ws.on('message', (d) => ws.msgs.push(JSON.parse(d.toString())));
  return new Promise((res, rej) => { ws.on('open', () => res(ws)); ws.on('error', rej); });
}

const pesoDe = (ws) => {
  const b = ws.msgs.filter((m) => m.tipo === 'balanza').pop();
  return b ? b.estado : null;
};

async function api(metodo, ruta, cuerpo) {
  const r = await fetch(URL + '/api' + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  return r.json();
}

async function estableEn(estacion, gramos) {
  for (let i = 0; i < 40; i++) {
    const d = await api('GET', `/balanza?estacion=${estacion}`);
    if (d.balanza.estable && d.balanza.gramos === gramos) return true;
    await esperar(150);
  }
  return false;
}

async function parteServidor(dir) {
  console.log('\n3. Servidor con dos estaciones');

  const guardadaAntes = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  chequear('config de prueba con 2 estaciones', guardadaAntes.estaciones.length === 2);

  const est = await api('GET', '/estaciones');
  chequear('GET /estaciones devuelve las dos con sus equipos',
    est.estaciones.length === 2 && est.estaciones[1].balanzaNombre === 'Balanza 2' && est.estaciones[1].escanerNombre === 'Escáner 2');

  const A = await wsCliente('?estacion=e1');
  const B = await wsCliente('?estacion=e2');
  const ADM = await wsCliente('?todo=1');
  await esperar(300);
  chequear('cada equipo recibe su estación al conectarse',
    A.msgs.some((m) => m.tipo === 'estacion' && m.estacion.id === 'e1') &&
    B.msgs.some((m) => m.tipo === 'estacion' && m.estacion.id === 'e2'));

  await api('POST', '/balanza/simular?estacion=e1', { gramos: 250 });
  await api('POST', '/balanza/simular?estacion=e2', { gramos: 500 });
  const ok1 = await estableEn('e1', 250);
  const ok2 = await estableEn('e2', 500);
  chequear('cada balanza queda en su peso', ok1 && ok2);
  await esperar(300);
  chequear('la estación 1 ve solo la balanza 1', pesoDe(A).gramos === 250 && A.msgs.every((m) => m.tipo !== 'balanza' || m.balanza === 'b1'));
  chequear('la estación 2 ve solo la balanza 2', pesoDe(B).gramos === 500 && B.msgs.every((m) => m.tipo !== 'balanza' || m.balanza === 'b2'));
  chequear('administración ve las dos', ADM.msgs.some((m) => m.balanza === 'b1') && ADM.msgs.some((m) => m.balanza === 'b2'));

  const c1 = await api('POST', '/balanza/capturar?estacion=e1');
  const c2 = await api('POST', '/balanza/capturar?estacion=e2');
  chequear('capturar en cada estación toma su balanza', c1.gramos === 250 && c2.gramos === 500, `${c1.gramos} / ${c2.gramos}`);

  // Escaner -> estacion
  const prod = await api('POST', '/productos', {
    nombre: 'Gaseosa prueba', tipo: 'unidad', precio_centavos: 150000, codigo_barras: '7790000000017',
  });
  chequear('producto de prueba con código', prod.ok, prod.error);
  A.msgs.length = 0; B.msgs.length = 0;
  await api('POST', '/escaner/simular', { escaner: 's2', codigo: '7790000000017' });
  await esperar(200);
  chequear('el escáner 2 manda el código a la estación 2', B.msgs.some((m) => m.tipo === 'escaneo' && m.codigo === '7790000000017'));
  chequear('y no a la estación 1', !A.msgs.some((m) => m.tipo === 'escaneo'));

  // Dos equipos en la misma estacion: el codigo va solo al ultimo usado.
  const A2 = await wsCliente('?estacion=e1');
  await esperar(100);
  A.send(JSON.stringify({ tipo: 'activo' }));
  await esperar(100);
  A.msgs.length = 0; A2.msgs.length = 0;
  await api('POST', '/escaner/simular', { estacion: 'e1', codigo: '1234567' });
  await esperar(200);
  const enA = A.msgs.filter((m) => m.tipo === 'escaneo').length;
  const enA2 = A2.msgs.filter((m) => m.tipo === 'escaneo').length;
  chequear('con dos equipos en la estación, el código va a uno solo (el último usado)', enA === 1 && enA2 === 0, `${enA} / ${enA2}`);
  A2.close();

  // Administracion abierta en un equipo de la estacion: si es la ultima usada,
  // el codigo es para ella (ficha o alta del articulo), no para un carrito.
  const ADM1 = await wsCliente('?todo=1&estacion=e1');
  await esperar(100);
  ADM1.send(JSON.stringify({ tipo: 'activo' }));
  await esperar(100);
  A.msgs.length = 0; ADM.msgs.length = 0; ADM1.msgs.length = 0;
  await api('POST', '/escaner/simular', { estacion: 'e1', codigo: '7790000000017' });
  await esperar(200);
  const aAdm1 = ADM1.msgs.filter((m) => m.tipo === 'escaneo');
  chequear('administración en la estación, última usada: el código es para ella', aAdm1.length === 1 && aAdm1[0].paraEste === true);
  chequear('y no llega al carrito del POS', !A.msgs.some((m) => m.tipo === 'escaneo'));
  chequear('administración sin estación lo ve como entregado a otro', ADM.msgs.some((m) => m.tipo === 'escaneo' && m.entregado && !m.paraEste));
  A.send(JSON.stringify({ tipo: 'activo' }));
  await esperar(100);
  A.msgs.length = 0; ADM1.msgs.length = 0;
  await api('POST', '/escaner/simular', { estacion: 'e1', codigo: '7790000000017' });
  await esperar(200);
  chequear('si después se usa el POS, el código vuelve al carrito',
    A.msgs.some((m) => m.tipo === 'escaneo') && ADM1.msgs.some((m) => m.tipo === 'escaneo' && !m.paraEste));
  A.msgs.length = 0; ADM1.msgs.length = 0;
  await api('POST', '/escaner/simular', { escaner: 's2', codigo: '7790000000017' });
  await esperar(200);
  chequear('administración de la estación 1 no toma el escáner 2', ADM1.msgs.some((m) => m.tipo === 'escaneo' && !m.paraEste));
  ADM1.close();

  // Ventas con estacion
  const v = await api('POST', '/ventas', { items: [{ producto_id: prod.producto.id, tipo: 'unidad', cantidad: 2 }], estacion: 'e2' });
  const lista = await api('GET', '/ventas?limite=5');
  chequear('la venta queda marcada con su estación', v.ok && lista.ventas[0].estacion === 'Mostrador 2' && lista.ventas[0].estacion_id === 'e2');
  chequear('el resumen del día separa por estación', (lista.porEstacion || []).some((x) => x.estacion === 'Mostrador 2' && x.ventas === 1));

  // Validaciones de administracion
  const disp = await api('GET', '/dispositivos');
  const base = { balanzas: disp.balanzas, escaneres: disp.escaneres, estaciones: disp.estaciones };
  let r = await api('PUT', '/dispositivos', { ...base, estaciones: base.estaciones.map((e) => ({ ...e, balanza: 'b1' })) });
  chequear('no deja la misma balanza en dos estaciones', !r.ok, r.error);
  r = await api('PUT', '/dispositivos', { ...base, balanzas: base.balanzas.map((b) => ({ ...b, simulador: false, puerto: 'COM3' })) });
  chequear('no deja dos balanzas en el mismo puerto', !r.ok, r.error);
  r = await api('PUT', '/dispositivos', { ...base, estaciones: [] });
  chequear('no deja sin estaciones', !r.ok);

  // Reasignacion en caliente: se cruzan las balanzas.
  A.msgs.length = 0; B.msgs.length = 0;
  r = await api('PUT', '/dispositivos', {
    ...base,
    estaciones: [
      { id: 'e1', nombre: 'Mostrador 1', balanza: 'b2', escaner: 's1' },
      { id: 'e2', nombre: 'Mostrador 2', balanza: 'b1', escaner: 's2' },
    ],
  });
  chequear('reasignar balanzas se guarda', r.ok, r.error);
  await esperar(400);
  chequear('la estación 1 pasa a ver la balanza 2 sin recargar', pesoDe(A) && pesoDe(A).id === 'b2' && pesoDe(A).gramos === 500);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  chequear('config.json queda con balanzas/escaneres/estaciones y sin "balanza"',
    Array.isArray(cfg.balanzas) && Array.isArray(cfg.estaciones) && !('balanza' in cfg) && cfg.estaciones[0].balanza === 'b2');
  chequear('config.json conserva el resto (sheets, venta)', !!cfg.venta && !!cfg.sheets);

  // Se da de baja la estacion 2: su equipo recibe la estacion de respaldo.
  B.msgs.length = 0;
  r = await api('PUT', '/dispositivos', { ...base, estaciones: [{ id: 'e1', nombre: 'Mostrador 1', balanza: 'b1', escaner: 's1' }] });
  await esperar(300);
  chequear('si se borra su estación, el equipo se entera', B.msgs.some((m) => m.tipo === 'estacion' && m.estacion.id === 'e1'));

  // Se restaura para la parte de pantalla.
  await api('PUT', '/dispositivos', base);
  A.close(); B.close(); ADM.close();
}

// ---------------------------------------------------------------- 4. pantalla

async function partePantalla() {
  let chromium;
  try {
    const rutaPw = process.env.PW || path.join(execSync('npm root -g').toString().trim(), 'playwright');
    ({ chromium } = require(rutaPw));
  } catch (_) {
    console.log('\n4. (salteado: Playwright no está instalado)');
    return;
  }
  console.log('\n4. Pantalla del POS con dos estaciones');
  const CHROME = process.env.PW_CHROME ||
    ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));
  const nav = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const ctx = await nav.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  const pag = await ctx.newPage();
  const errores = [];
  pag.on('pageerror', (e) => errores.push(e.message));
  try {
    await pag.goto(URL, { waitUntil: 'networkidle' });
    await esperar(600);
    chequear('el equipo pregunta en qué estación trabaja', await pag.locator('#selectorEstacion').isVisible());
    chequear('muestra las dos con su balanza', (await pag.locator('.selector-opcion').count()) === 2);
    const salida = path.join(RAIZ, 'capturas');
    if (!fs.existsSync(salida)) fs.mkdirSync(salida, { recursive: true });
    await pag.screenshot({ path: path.join(salida, 'estaciones-1-elegir.png') });

    await pag.locator('.selector-opcion', { hasText: 'Mostrador 2' }).click();
    await esperar(800);
    chequear('elegida, se cierra el selector', !(await pag.locator('#selectorEstacion').isVisible()));
    chequear('arriba del peso dice la estación', (await pag.locator('#chipEstacionTexto').textContent()) === 'Mostrador 2');
    chequear('muestra el peso de SU balanza', (await pag.locator('#pesoNumero').textContent()) === '0,500');
    chequear('y el estado de su escáner', (await pag.locator('#chipEscaner').textContent()).includes('Escáner'));

    await api('POST', '/escaner/simular', { estacion: 'e2', codigo: '7790000000017' });
    await esperar(900);
    const items = await pag.locator('#carritoLista .item').count();
    chequear('el escáner de la estación carga el producto en este equipo', items === 1, items + ' ítem(s)');
    await api('POST', '/escaner/simular', { estacion: 'e1', codigo: '7790000000017' });
    await esperar(700);
    chequear('el escáner de la otra estación no', (await pag.locator('#carritoLista .item').count()) === 1);
    await pag.screenshot({ path: path.join(salida, 'estaciones-2-venta.png') });

    await pag.reload({ waitUntil: 'networkidle' });
    await esperar(700);
    chequear('al recargar recuerda la estación sin preguntar',
      !(await pag.locator('#selectorEstacion').isVisible()) &&
      (await pag.locator('#chipEstacionTexto').textContent()) === 'Mostrador 2');

    await pag.locator('#chipEstacion').click();
    await esperar(400);
    chequear('tocando el nombre se puede cambiar', await pag.locator('#selectorEstacion').isVisible());
    await pag.locator('.selector-opcion', { hasText: 'Mostrador 1' }).click();
    await esperar(800);
    chequear('cambia a la balanza de la otra estación', (await pag.locator('#pesoNumero').textContent()) === '0,250');

    await pag.goto(URL + '/admin.html', { waitUntil: 'networkidle' });
    await pag.locator('.tab', { hasText: 'Estaciones' }).click();
    await esperar(900);
    chequear('admin: lista las 2 estaciones, 2 balanzas y 2 escáneres',
      (await pag.locator('.fila-estacion').count()) === 2 &&
      (await pag.locator('#listaBalanzas .equipo').count()) === 2 &&
      (await pag.locator('#listaEscaneres .equipo').count()) === 2);
    await pag.locator('#btnAgregarEstacion').click();
    chequear('agregar una estación habilita Guardar', !(await pag.locator('#btnGuardarEquipos').isDisabled()));
    await pag.screenshot({ path: path.join(salida, 'estaciones-3-admin.png'), fullPage: true });
    await pag.locator('#btnDescartar').click();
    chequear('descartar vuelve a lo guardado', (await pag.locator('.fila-estacion').count()) === 2);

    // Escanear en administracion: abre la ficha del articulo o el alta.
    // Este equipo quedo en Mostrador 1, asi que el escaner 1 le habla a admin.
    const titulo = () => pag.locator('#formTitulo').textContent();
    const foco = () => pag.evaluate(() => document.activeElement && document.activeElement.id);
    await api('POST', '/escaner/simular', { estacion: 'e1', codigo: '7790000000017' });
    await esperar(900);
    chequear('admin: escanear un código existente abre su ficha',
      !(await pag.locator('[data-panel="productos"]').isHidden()) && (await titulo()) === 'Editando: Gaseosa prueba');
    chequear('con el precio listo para cambiar', (await foco()) === 'prodPrecio' &&
      (await pag.locator('#prodPrecio').inputValue()) === '1500.00');
    await pag.screenshot({ path: path.join(salida, 'estaciones-4-admin-escaneo-existe.png') });

    await api('POST', '/escaner/simular', { estacion: 'e1', codigo: '7791234567890' });
    await esperar(900);
    chequear('admin: un código nuevo abre el alta con el código cargado',
      /^Nuevo producto/.test(await titulo()) && (await pag.locator('#prodCodigo').inputValue()) === '7791234567890');
    chequear('por unidad y con el cursor en el nombre',
      (await pag.locator('#prodTipo').inputValue()) === 'unidad' && (await foco()) === 'prodNombre');
    await pag.screenshot({ path: path.join(salida, 'estaciones-5-admin-escaneo-alta.png') });
    await pag.locator('#prodNombre').fill('Alfajor prueba');
    await pag.locator('#prodPrecio').fill('900');
    await pag.locator('#prodPrecio').press('Enter');
    await esperar(700);
    const alta = await api('GET', '/productos/codigo/7791234567890');
    chequear('guardar da de alta el artículo con ese código', alta.ok && alta.producto.nombre === 'Alfajor prueba' && alta.producto.tipo === 'unidad');

    // Escaner "teclado" (PC): tecleo rapido + Enter, escribiendo sobre el buscador.
    await pag.locator('#filtroProductos').click();
    await pag.keyboard.type('7791234567890', { delay: 8 });
    await pag.keyboard.press('Enter');
    await esperar(900);
    chequear('escáner teclado: abre la ficha del artículo', (await titulo()) === 'Editando: Alfajor prueba');
    chequear('y no deja el código escrito en el buscador', (await pag.locator('#filtroProductos').inputValue()) === '');
    await pag.locator('#prodPrecio').fill('950');
    await pag.locator('#prodPrecio').press('Enter');
    await esperar(700);
    const nuevoPrecio = await api('GET', '/productos/codigo/7791234567890');
    chequear('cambiar el precio y Enter lo guarda', nuevoPrecio.producto.precio_centavos === 95000);

    // Con el cursor en "Codigo de barras" el escaneo solo completa ese campo.
    await pag.locator('#prodNombre').fill('Otro sin código');
    await pag.locator('#prodCodigo').click();
    await pag.keyboard.type('7790000000017', { delay: 8 });
    await pag.keyboard.press('Enter');
    await esperar(700);
    chequear('escanear en el campo código no sale del formulario',
      (await titulo()) === 'Nuevo producto' && (await pag.locator('#prodNombre').inputValue()) === 'Otro sin código' &&
      (await pag.locator('#prodCodigo').inputValue()) === '7790000000017');
    await pag.locator('#btnCancelar').click().catch(() => {});
    await pag.evaluate(() => document.getElementById('formProducto').reset());

    // Si despues se vuelve a usar el POS en la estacion, el codigo va al carrito.
    await pag.goto(URL, { waitUntil: 'networkidle' });
    await esperar(700);
    const antes = await pag.locator('#carritoLista .item').count();
    await api('POST', '/escaner/simular', { estacion: 'e1', codigo: '7790000000017' });
    await esperar(900);
    chequear('de vuelta en el POS, el escáner carga el carrito', (await pag.locator('#carritoLista .item').count()) === antes + 1);

    chequear('sin errores de JavaScript', errores.length === 0, errores.join(' | ') || 'ninguno');
  } finally {
    await nav.close();
  }
}

// ---------------------------------------------------------------- main

(async function main() {
  parteMigracion();
  await partePuertos();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-estaciones-'));
  const real = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.json'), 'utf8'));
  const bal = (id, nombre) => ({ id, nombre, simulador: true, puerto: '', protocolo: 'kretz', stopBits: 2 });
  const esc = (id, nombre) => ({ id, nombre, simulador: true, puerto: '' });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    http: { port: PUERTO, host: '127.0.0.1' },
    venta: real.venta,
    sheets: { ...(real.sheets || {}), habilitado: false },
    balanzas: [bal('b1', 'Balanza 1'), bal('b2', 'Balanza 2')],
    escaneres: [esc('s1', 'Escáner 1'), esc('s2', 'Escáner 2')],
    estaciones: [
      { id: 'e1', nombre: 'Mostrador 1', balanza: 'b1', escaner: 's1' },
      { id: 'e2', nombre: 'Mostrador 2', balanza: 'b2', escaner: 's2' },
    ],
  }, null, 2));

  const servidor = spawn(process.execPath, [path.join(RAIZ, 'src', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, POS_CONFIG: path.join(dir, 'config.json'), POS_DATA: dir, POS_SIN_SHEETS: '1' },
  });
  const terminar = (c) => {
    try { servidor.kill(); } catch (_) {}
    setTimeout(() => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      process.exit(c);
    }, 500);
  };

  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(URL + '/api/estaciones'); break; } catch (_) { await esperar(200); }
    }
    await parteServidor(dir);
    await partePantalla();
  } catch (e) {
    fallos++;
    console.log('  MAL  error inesperado: ' + (e.stack || e.message));
  }

  console.log('\n---------------------------------------------');
  console.log(fallos ? `  ${fallos} verificación(es) fallaron` : '  Todo OK.');
  console.log('---------------------------------------------\n');
  terminar(fallos ? 1 : 0);
})();
