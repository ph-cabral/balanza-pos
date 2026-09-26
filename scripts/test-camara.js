'use strict';

/**
 * Prueba del lector de codigos con la camara y del HTTPS en el mismo puerto.
 *
 * No toca la configuracion ni la base reales: servidor con config y datos
 * temporales en el puerto 3061. La camara es la "camara falsa" de Chromium
 * alimentada con un video generado aca (un EAN-13 dibujado en cuadros YUV).
 *
 *   npm run test-camara
 *
 * Partes:
 *   1. Certificado propio (src/tls.js): valido, con las IP, se reutiliza.
 *   2. Servidor: http y https en el mismo puerto, WebSocket por ws y wss,
 *      /api/red con las direcciones seguras, .wasm con su tipo.
 *   3. Pantalla (si hay Playwright), en tamaño celular:
 *      - boton de camara entre los grupos, escondido al ordenar
 *      - lee el codigo, carga el producto y sube el carrito
 *      - codigo sin producto: aviso
 *      - la X y el boton "atras" cierran la camara sin salir del POS
 *      - por http://IP (no seguro) ofrece pasar a https y funciona ahi
 *      - con una venta abierta no cambia de direccion
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const PUERTO = 3061;
const URL = `http://localhost:${PUERTO}`;
const CODIGO = '7790895000997';          // producto de prueba
const CODIGO_SIN_PRODUCTO = '7790520000019';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // certificado autofirmado de la prueba

let fallos = 0;
function chequear(desc, cond, detalle) {
  if (!cond) fallos++;
  console.log(`  ${cond ? 'OK  ' : 'MAL '} ${desc}${detalle !== undefined ? '  -> ' + detalle : ''}`);
}

async function api(metodo, ruta, cuerpo, base = URL) {
  const r = await fetch(base + '/api' + ruta, {
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  return r.json();
}

function ipDeRed() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.internal && !i.address.startsWith('169.254.')) return i.address;
    }
  }
  return null;
}

// ---------------------------------------------------------------- video falso

/** Barras de un EAN-13 (95 modulos) como string de 0/1. */
function barrasEan13(codigo) {
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const G = L.map((p) => p.split('').reverse().map((b) => (b === '1' ? '0' : '1')).join(''));
  const R = L.map((p) => p.split('').map((b) => (b === '1' ? '0' : '1')).join(''));
  const PARIDAD = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  const d = codigo.split('').map(Number);
  const par = PARIDAD[d[0]];
  let s = '101';
  for (let i = 1; i <= 6; i++) s += (par[i - 1] === 'L' ? L : G)[d[i]];
  s += '01010';
  for (let i = 7; i <= 12; i++) s += R[d[i]];
  return s + '101';
}

/**
 * Video .y4m (el formato que acepta la camara falsa de Chromium). Vertical,
 * como la camara de un celular parado, con el codigo al centro.
 */
function videoConCodigo(ruta, codigo) {
  const W = 480;
  const H = 640;
  const y = Buffer.alloc(W * H, 140);            // fondo gris
  if (codigo) {
    const barras = barrasEan13(codigo);
    const m = 2;                                 // pixeles por modulo
    const x0 = Math.floor((W - barras.length * m) / 2);
    const y0 = 270;
    for (let fy = y0 - 20; fy < y0 + 120; fy++) {
      for (let fx = x0 - 25; fx < x0 + barras.length * m + 25; fx++) y[fy * W + fx] = 255;
    }
    for (let i = 0; i < barras.length; i++) {
      if (barras[i] !== '1') continue;
      for (let fy = y0; fy < y0 + 100; fy++) for (let k = 0; k < m; k++) y[fy * W + x0 + i * m + k] = 0;
    }
  }
  const uv = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  const partes = [Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`)];
  for (let f = 0; f < 5; f++) partes.push(Buffer.from('FRAME\n'), y, uv);
  fs.writeFileSync(ruta, Buffer.concat(partes));
}

// ---------------------------------------------------------------- 1. certificado

function parteCertificado(dir) {
  console.log('\n1. Certificado propio');
  const tls = require('../src/tls');
  const carpeta = path.join(dir, 'tls-prueba');
  const a = tls.cargarOCrear(carpeta);
  chequear('se genera la primera vez', a.nuevo && fs.existsSync(path.join(carpeta, 'pos.crt')));
  const x = new crypto.X509Certificate(a.cert);
  chequear('la firma es válida (autofirmado)', x.verify(x.publicKey));
  chequear('cubre localhost y 127.0.0.1', !!x.checkHost('localhost') && !!x.checkIP('127.0.0.1'), x.subjectAltName);
  const ip = ipDeRed();
  if (ip) chequear('cubre la IP de la red', !!x.checkIP(ip), ip);
  const dias = (new Date(x.validTo) - Date.now()) / 86400000;
  chequear('vence en menos de 825 días (límite de Safari)', dias > 700 && dias < 825, Math.round(dias));
  const b = tls.cargarOCrear(carpeta);
  chequear('la segunda vez usa el mismo', !b.nuevo && String(b.cert) === String(a.cert));
}

// ---------------------------------------------------------------- 2. servidor

async function parteServidor() {
  console.log('\n2. HTTP y HTTPS en el mismo puerto');
  const WebSocket = require('ws');
  const r1 = await api('GET', '/estaciones');
  const r2 = await api('GET', '/estaciones', null, `https://localhost:${PUERTO}`);
  chequear('responde por http', r1.ok === true);
  chequear('y por https en el mismo puerto', r2.ok === true);

  const ws = (u) => new Promise((ok) => {
    const w = new WebSocket(u, { rejectUnauthorized: false });
    const t = setTimeout(() => { w.terminate(); ok(null); }, 3000);
    w.on('message', (m) => { clearTimeout(t); w.close(); ok(JSON.parse(String(m))); });
    w.on('error', () => { clearTimeout(t); ok(null); });
  });
  const m1 = await ws(`ws://localhost:${PUERTO}/ws?estacion=e1`);
  const m2 = await ws(`wss://localhost:${PUERTO}/ws?estacion=e1`);
  chequear('WebSocket por ws://', m1 && m1.tipo === 'estacion');
  chequear('WebSocket por wss://', m2 && m2.tipo === 'estacion');
  const otra = await ws(`ws://localhost:${PUERTO}/otra`);
  chequear('otra ruta de WebSocket se rechaza', otra === null);

  const red = await api('GET', '/red');
  const ip = ipDeRed();
  chequear('/api/red trae las direcciones seguras', Array.isArray(red.seguras) &&
    (!ip || red.seguras.includes(`https://${ip}:${PUERTO}`)), JSON.stringify(red.seguras));

  const w = await fetch(URL + '/vendor/barcode-detector/zxing_reader.wasm');
  chequear('el lector de respaldo (.wasm) se sirve desde el POS', w.ok && w.headers.get('content-type') === 'application/wasm',
    w.headers.get('content-type'));
}

// ---------------------------------------------------------------- 3. pantalla

async function partePantalla(dir) {
  let chromium;
  try {
    const rutaPw = process.env.PW || path.join(execSync('npm root -g').toString().trim(), 'playwright');
    ({ chromium } = require(rutaPw));
  } catch (_) {
    console.log('\n3. (salteado: Playwright no está instalado)');
    return;
  }
  const CHROME = process.env.PW_CHROME ||
    ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));

  const videoOk = path.join(dir, 'codigo.y4m');
  const videoOtro = path.join(dir, 'otro.y4m');
  const videoVacio = path.join(dir, 'vacio.y4m');
  videoConCodigo(videoOk, CODIGO);
  videoConCodigo(videoOtro, CODIGO_SIN_PRODUCTO);
  videoConCodigo(videoVacio, null);

  const salida = path.join(RAIZ, 'capturas');
  if (!fs.existsSync(salida)) fs.mkdirSync(salida, { recursive: true });

  async function conCamara(video, fn) {
    const nav = await chromium.launch({
      ...(CHROME ? { executablePath: CHROME } : {}),
      // --no-proxy-server: si el equipo tiene proxy, que no se meta con la IP local.
      args: ['--no-proxy-server', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${video}`],
    });
    const ctx = await nav.newContext({
      viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true,
      ignoreHTTPSErrors: true, permissions: ['camera'],
    });
    const pag = await ctx.newPage();
    const errores = [];
    pag.on('pageerror', (e) => errores.push(e.message));
    pag.on('console', (m) => {
      // Un codigo sin producto responde 404 a proposito: no es un error de la pantalla.
      if (m.type() === 'error' && !/api\/productos\/codigo\//.test((m.location() || {}).url || '')) errores.push(m.text());
    });
    try { await fn(pag, errores); } finally { await nav.close(); }
  }

  const carritoTiene = (pag, txt) => pag.waitForFunction(
    (t) => document.querySelector('#carritoLista').textContent.indexOf(t) !== -1, txt, { timeout: 15000 },
  ).then(() => true, () => false);

  console.log('\n3. Pantalla en tamaño celular (cámara falsa de Chromium)');

  await conCamara(videoOk, async (pag, errores) => {
    await pag.goto(URL, { waitUntil: 'networkidle' });
    await pag.waitForSelector('#btnCamara', { timeout: 5000 }).catch(() => {});
    const boton = pag.locator('#btnCamara');
    chequear('botón de cámara entre los grupos', await boton.isVisible());
    chequear('es el primer casillero', await pag.evaluate(() => document.querySelector('#grupos').firstElementChild.id === 'btnCamara'));
    await pag.screenshot({ path: path.join(salida, 'camara-1-grupos.png') });

    await pag.click('#btnOrdenar');
    chequear('en modo ordenar se esconde', !(await boton.isVisible()));
    await pag.click('#btnOrdenar');
    chequear('y vuelve al salir', await boton.isVisible());

    await boton.click();
    await pag.waitForSelector('.camara', { timeout: 5000 });
    chequear('abre la cámara a pantalla completa', await pag.locator('.camara video').isVisible());
    await esperar(400);
    await pag.screenshot({ path: path.join(salida, 'camara-2-leyendo.png') });
    const t0 = Date.now();
    const cargado = await carritoTiene(pag, 'Gaseosa');
    chequear('lee el código y carga el producto al carrito', cargado, `${Date.now() - t0} ms`);
    chequear('la cámara se cerró sola', (await pag.locator('.camara').count()) === 0);
    chequear('la cámara quedó apagada', await pag.evaluate(() => !window.Camara.abierta()));
    chequear('el carrito sube para mostrarlo', await pag.evaluate(() => document.querySelector('#hoja').classList.contains('abierta')));
    const det = await pag.evaluate(() => window.Camara.detector());
    chequear('detector usado en este navegador', !!det, det);
    await pag.screenshot({ path: path.join(salida, 'camara-3-carrito.png') });

    // Otra vez el mismo: suma una unidad (no duplica la linea).
    await esperar(6500);
    await pag.click('#btnCamara');
    const dos = await pag.waitForFunction(() => {
      const v = document.querySelectorAll('#carritoLista .cant-valor');
      return v.length === 1 && v[0].textContent.trim() === '2';
    }, null, { timeout: 15000 }).then(() => true, () => false);
    chequear('escanear de nuevo suma una unidad (misma línea)', dos,
      await pag.evaluate(() => document.querySelector('#carritoLista').textContent.replace(/\s+/g, ' ')));
    chequear('sin errores de JavaScript', errores.length === 0, errores.join(' | '));
  });

  await conCamara(videoOtro, async (pag, errores) => {
    await pag.goto(URL, { waitUntil: 'networkidle' });
    await pag.click('#btnCamara');
    const aviso = await pag.waitForFunction(
      (c) => document.querySelector('#avisos').textContent.indexOf(c) !== -1, CODIGO_SIN_PRODUCTO, { timeout: 15000 },
    ).then(() => true, () => false);
    chequear('código sin producto: avisa y no carga nada', aviso &&
      (await pag.evaluate(() => document.querySelectorAll('#carritoLista .carrito-vacio').length === 1)));
    chequear('sin errores de JavaScript', errores.length === 0, errores.join(' | '));
  });

  await conCamara(videoVacio, async (pag, errores) => {
    await pag.goto(URL, { waitUntil: 'networkidle' });
    const url0 = pag.url();
    await pag.click('#btnCamara');
    await pag.waitForSelector('.camara video');
    await esperar(800);
    chequear('sin código a la vista sigue buscando', (await pag.locator('.camara').count()) === 1);
    await pag.click('.camara-cerrar');
    await esperar(300);
    chequear('la X la cierra', (await pag.locator('.camara').count()) === 0 && !(await pag.evaluate(() => window.Camara.abierta())));
    chequear('y se queda en el POS', pag.url() === url0);

    await pag.click('#btnCamara');
    await pag.waitForSelector('.camara video');
    await pag.goBack();
    await esperar(400);
    chequear('"atrás" cierra la cámara sin salir del POS', (await pag.locator('.camara').count()) === 0 && pag.url() === url0
      && (await pag.locator('#vistaGrupos').isVisible()));

    // Por la IP con http (no seguro): ofrece la version https.
    const ip = ipDeRed();
    if (!ip) {
      console.log('  (sin IP de red: se saltea la prueba por http://IP)');
    } else {
      const inseguro = `http://${ip}:${PUERTO}/`;
      await pag.goto(inseguro, { waitUntil: 'networkidle' });
      chequear('por http://IP la página no es segura', !(await pag.evaluate(() => window.isSecureContext)));
      chequear('en celular igual muestra el botón', await pag.locator('#btnCamara').isVisible());
      await pag.click('#btnCamara');
      const ir = pag.locator('.aviso-accion', { hasText: 'versión segura' });
      chequear('avisa y ofrece ir a la versión segura', await ir.isVisible());
      await esperar(300);
      await pag.screenshot({ path: path.join(salida, 'camara-4-inseguro.png') });
      await Promise.all([pag.waitForNavigation({ waitUntil: 'networkidle' }), ir.click()]);
      chequear('pasa a https en el mismo puerto', pag.url() === `https://${ip}:${PUERTO}/`, pag.url());
      chequear('ahí la página es segura', await pag.evaluate(() => window.isSecureContext));
      await pag.waitForFunction(() => document.querySelector('#chipTexto').textContent.indexOf('Conectando') === -1,
        null, { timeout: 5000 }).catch(() => {});
      chequear('y el peso llega por wss', await pag.evaluate(() => !/Conectando|Sin conex/i.test(document.querySelector('#chipTexto').textContent)),
        await pag.evaluate(() => document.querySelector('#chipTexto').textContent));
      await pag.click('#btnCamara');
      chequear('y la cámara abre', await pag.waitForSelector('.camara video', { timeout: 5000 }).then(() => true, () => false));
      await pag.click('.camara-cerrar');

      // Con una venta abierta no se cambia de direccion (se perderia).
      await pag.goto(inseguro, { waitUntil: 'networkidle' });
      await pag.fill('#buscador', 'Gaseosa');
      await pag.click('#grilla .prod');
      await pag.waitForFunction(() => document.querySelectorAll('#carritoLista .item').length === 1, null, { timeout: 5000 });
      await pag.click('#btnLimpiarBusqueda');
      await esperar(300);
      await pag.evaluate(() => document.querySelector('#btnCamara').click());
      await esperar(200);
      chequear('con venta abierta no ofrece cambiar de dirección',
        (await pag.locator('.aviso-accion', { hasText: 'versión segura' }).count()) === 0 &&
        (await pag.evaluate(() => /Cerrá la venta/.test(document.querySelector('#avisos').textContent))) &&
        pag.url() === inseguro);
    }
    chequear('sin errores de JavaScript', errores.length === 0, errores.join(' | '));
  });
}

// ---------------------------------------------------------------- main

(async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-camara-'));
  parteCertificado(dir);

  const ejemplo = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.example.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    ...ejemplo,
    http: { port: PUERTO, host: '0.0.0.0' },
    sheets: { ...(ejemplo.sheets || {}), habilitado: false, importar: false },
    balanzas: [{ ...ejemplo.balanzas[0], simulador: true, puerto: '' }],
  }, null, 2));

  const env = {
    ...process.env, POS_CONFIG: path.join(dir, 'config.json'), POS_DATA: dir, POS_SIN_SHEETS: '1',
    POS_CONFIG_COMUN: path.join(dir, 'no-existe.json'),
  };
  const servidor = spawn(process.execPath, [path.join(RAIZ, 'src', 'server.js')], { stdio: ['ignore', 'ignore', 'inherit'], env });
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
    const grupos = await api('GET', '/categorias');
    const gaseosas = (grupos.categorias || []).find((g) => /Gaseosas/.test(g.nombre));
    const prod = await api('POST', '/productos', {
      nombre: 'Gaseosa 500 ml', tipo: 'unidad', precio_centavos: 150000, codigo_barras: CODIGO,
      categoria_id: gaseosas ? gaseosas.id : undefined,
    });
    if (!prod.ok) throw new Error('no se pudo crear el producto de prueba: ' + prod.error);

    await parteServidor();
    await partePantalla(dir);
  } catch (e) {
    fallos++;
    console.log('  MAL  error inesperado: ' + (e.stack || e.message));
  }

  console.log('\n---------------------------------------------');
  console.log(fallos ? `  ${fallos} verificación(es) fallaron` : '  Todo OK.');
  console.log('---------------------------------------------\n');
  terminar(fallos ? 1 : 0);
})();
