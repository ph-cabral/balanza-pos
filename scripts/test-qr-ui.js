'use strict';

/**
 * Prueba de la pantalla del cobro con QR fijo de Mercado Pago (automatico, sin boton),
 * con navegador real y Mercado Pago simulado:
 *   - con el carrito armado la orden se crea sola y la pantalla muestra el monto
 *   - al cambiar el carrito la orden se actualiza (la anterior se cancela)
 *   - cerrar la venta en efectivo baja la orden
 *   - recargar la pantalla con la orden viva la retoma
 *   - al pagarse en MP la venta se guarda UNA vez (qr_mp) y el carrito queda limpio
 *   - si la orden vence y el carrito sigue, se crea otra sola
 *
 * No toca MP ni la base real: config y base temporales, puerto 3062.
 *
 *   node scripts/test-qr-ui.js
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const RUTA_PW = process.env.PW || path.join(execSync('npm root -g').toString().trim(), 'playwright');
const { chromium } = require(RUTA_PW);

const RAIZ = path.join(__dirname, '..');
const PUERTO = 3062;
const URL = `http://localhost:${PUERTO}`;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.PW_CHROME ||
  ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));

let fallos = 0;
function chequear(desc, cond, detalle) {
  if (!cond) fallos++;
  console.log(`  ${cond ? 'OK  ' : 'MAL '} ${desc}${detalle ? '  -> ' + detalle : ''}`);
}

function crearMP() {
  const m = { ordenes: new Map(), n: 0 };
  m.server = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; });
    req.on('end', () => {
      const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.method === 'POST' && req.url === '/v1/orders') {
        const b = JSON.parse(cuerpo);
        const id = `ORD${++m.n}`;
        m.ordenes.set(id, { id, status: 'created', total_amount: b.total_amount, external_reference: b.external_reference });
        return json(201, m.ordenes.get(id));
      }
      let r = req.url.match(/^\/v1\/orders\/([^/]+)$/);
      if (req.method === 'GET' && r) { const o = m.ordenes.get(r[1]); return o ? json(200, o) : json(404, {}); }
      r = req.url.match(/^\/v1\/orders\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && r) { const o = m.ordenes.get(r[1]); o.status = 'canceled'; return json(200, o); }
      json(404, {});
    });
  });
  return m;
}

(async function main() {
  const mp = crearMP();
  await new Promise((r) => mp.server.listen(0, r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-qrui-'));
  const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.example.json'), 'utf8'));
  cfg.http.port = PUERTO;
  for (const b of cfg.balanzas) b.simulador = true;
  cfg.sheets = { habilitado: false, importar: false };
  cfg.mediosPago = { qr: 0, tarjeta: 0 };
  cfg.mercadopago = { habilitado: true, accessToken: 'T', externalPosId: 'CAJA1', expiracionMinutos: 5, consultaSegundos: 2 };
  const ruta = path.join(dir, 'config.json');
  fs.writeFileSync(ruta, JSON.stringify(cfg));

  const servidor = spawn(process.execPath, [path.join(RAIZ, 'src', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, POS_CONFIG: ruta, POS_DATA: dir, POS_CONFIG_COMUN: path.join(dir, 'no.json'), POS_MP_BASE: `http://localhost:${mp.server.address().port}`, POS_SIN_SHEETS: '1' },
  });
  let navegador = null;
  const terminar = async (c) => {
    try { if (navegador) await navegador.close(); } catch (_) {}
    try { servidor.kill(); } catch (_) {}
    try { mp.server.close(); } catch (_) {}
    await esperar(300);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    process.exit(c);
  };
  for (let i = 0; i < 50; i++) { try { await fetch(URL + '/api/red'); break; } catch (_) { await esperar(200); } }

  const api = (r, b) => fetch(URL + r, b ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) } : undefined).then((x) => x.json());
  const prod = (await api('/api/productos', { nombre: 'Gaseosa 2L', tipo: 'unidad', precio_centavos: 345050, codigo_barras: '7790000000012' })).producto;

  navegador = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const ctx = await navegador.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  const pagina = await ctx.newPage();
  const errores = [];
  pagina.on('pageerror', (e) => errores.push(e.message));
  pagina.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errores.push(m.text()); });

  try {
    await pagina.goto(URL + '/');
    await pagina.waitForSelector('#vistaGrupos', { timeout: 15000 });
    const escanear = async () => { await pagina.keyboard.type('7790000000012'); await pagina.keyboard.press('Enter'); };
    const carritoN = () => pagina.evaluate(() => document.querySelectorAll('#carritoLista .item').length);

    const abiertas = () => [...mp.ordenes.values()].filter((o) => o.status === 'created');
    const esperarBanda = (monto) => pagina.waitForFunction((m) => {
      const b = document.querySelector('#qrBanda');
      return b.hidden && document.querySelector('#qrMonto').textContent.includes(m); // la banda no se muestra: ocupa lugar
    }, monto, { timeout: 10000 });

    console.log('\n1. Sin boton');
    chequear('no existe el boton "Cobrar con QR"', (await pagina.locator('#btnCobrarQr').count()) === 0);
    await esperar(800);
    chequear('con el carrito vacio no hay QR ni orden', await pagina.locator('#qrBanda').isHidden() && mp.n === 0);

    console.log('\n2. La orden se crea sola con el carrito');
    await escanear();
    await pagina.waitForFunction(() => document.querySelector('#total').textContent.includes('3.450'), null, { timeout: 8000 });
    await esperarBanda('3.450,50');
    chequear('aparece el monto del QR sin tocar nada', true, await pagina.locator('#qrMonto').innerText());
    chequear('una orden abierta por el total', abiertas().length === 1 && abiertas()[0].total_amount === '3450.50', abiertas().map((o) => o.total_amount).join());
    chequear('la venta todavia NO existe', (await api('/api/ventas')).ventas.length === 0);

    console.log('\n3. Cambia el carrito: la orden se actualiza sola');
    await esperar(3500); // vuelta automatica a grupos
    await escanear();
    await esperarBanda('6.901,00');
    chequear('monto nuevo en pantalla', true, await pagina.locator('#qrMonto').innerText());
    chequear('una sola orden abierta, con el total nuevo; la anterior cancelada', abiertas().length === 1 && abiertas()[0].total_amount === '6901.00' && mp.ordenes.get('ORD1').status === 'canceled', abiertas().map((o) => o.total_amount).join());

    console.log('\n4. Cierre en efectivo baja el QR');
    await pagina.locator('#btnCobrar').click();
    await pagina.waitForFunction(() => document.querySelector('#qrBanda').hidden && document.querySelectorAll('#carritoLista .item').length === 0, null, { timeout: 10000 });
    chequear('QR oculto y carrito limpio', true);
    chequear('sin ordenes abiertas en MP', abiertas().length === 0);
    let ventas = await api('/api/ventas');
    chequear('una venta, sin medio QR', ventas.ventas.length === 1 && ventas.ventas[0].total_centavos === 690100, JSON.stringify(ventas.ventas.map((v) => v.total_centavos)));
    await esperar(2500);
    chequear('no quedan ordenes abiertas despues de un rato', abiertas().length === 0);

    console.log('\n5. Recarga con la orden viva');
    await escanear();
    await esperarBanda('3.450,50');
    const orden = abiertas()[0];
    await pagina.reload();
    await pagina.waitForSelector('#vistaGrupos', { timeout: 15000 });
    await esperarBanda('3.450,50');
    chequear('el QR vuelve solo tras recargar', true);
    orden.status = 'processed';
    await pagina.waitForFunction(() => /cobrada por QR/.test(document.querySelector('#avisos').innerText), null, { timeout: 15000 });
    await pagina.waitForSelector('#qrBanda', { state: 'hidden', timeout: 8000 });
    ventas = await api('/api/ventas');
    chequear('al acreditarse: banda oculta y una venta mas por el total', ventas.ventas.length === 2 && ventas.ventas[0].total_centavos === 345050, JSON.stringify(ventas.ventas.map((v) => v.total_centavos)));
    const det = await api(`/api/ventas/${ventas.ventas[0].id}`);
    chequear('medio de pago qr_mp', det.venta.medio_pago === 'qr_mp');

    console.log('\n6. Pago con el carrito de esta pantalla');
    await escanear();
    await pagina.waitForFunction(() => document.querySelector('#total').textContent.includes('3.450'), null, { timeout: 8000 });
    await esperarBanda('3.450,50');
    abiertas().forEach((o) => { o.status = 'processed'; });
    await pagina.waitForFunction(() => /guardada · QR/.test(document.querySelector('#avisos').innerText), null, { timeout: 15000 });
    chequear('aviso "guardada · QR" y carrito limpio', (await carritoN()) === 0);
    chequear('tres ventas en total', (await api('/api/ventas')).ventas.length === 3);

    console.log('\n7. Orden vencida: se renueva sola mientras el carrito siga');
    await esperar(3500);
    await escanear();
    await esperarBanda('3.450,50');
    const vieja = abiertas()[0];
    vieja.status = 'expired';
    await pagina.waitForFunction(() => document.querySelector('#total').textContent.includes('3.450'), null, { timeout: 8000 });
    for (let i = 0; i < 30 && abiertas().length === 0; i++) await esperar(500);
    chequear('hay una orden nueva abierta por el mismo total', abiertas().length === 1 && abiertas()[0].id !== vieja.id && abiertas()[0].total_amount === '3450.50', abiertas().map((o) => o.id + ':' + o.total_amount).join());
    chequear('la venta sigue sin guardarse', (await api('/api/ventas')).ventas.length === 3);

    chequear('sin errores de consola/JS', errores.length === 0, errores.join(' | '));
  } catch (e) {
    console.error(e);
    fallos++;
  }

  console.log(fallos ? `\n${fallos} verificación(es) fallaron\n` : '\nTodo OK\n');
  await terminar(fallos ? 1 : 0);
})();
