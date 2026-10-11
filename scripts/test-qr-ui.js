'use strict';

/**
 * Prueba de la pantalla del cobro con QR fijo de Mercado Pago, con navegador
 * real y Mercado Pago simulado:
 *   - el boton "Cobrar con QR" solo existe con mercadopago habilitado
 *   - escanear un articulo, tocar el boton: ventana con el monto, sin venta guardada
 *   - con el cobro en curso no se agregan articulos
 *   - al pagarse en MP la ventana se cierra sola, el carrito queda limpio y hay UNA venta (qr_mp)
 *   - cancelar el cobro vuelve a la venta abierta (carrito intacto) y se puede cobrar de nuevo
 *   - recargar la pantalla en medio del cobro lo retoma
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

    console.log('\n1. Boton');
    await pagina.waitForFunction(() => !document.querySelector('#btnCobrarQr').hidden, null, { timeout: 10000 });
    chequear('con MP habilitado aparece "Cobrar con QR"', true);
    chequear('deshabilitado con el carrito vacio', await pagina.locator('#btnCobrarQr').isDisabled());

    console.log('\n2. Cobro en curso');
    await escanear();
    await pagina.waitForFunction(() => document.querySelector('#total').textContent.includes('3.450'), null, { timeout: 8000 });
    chequear('articulo escaneado en el carrito', (await carritoN()) >= 1);
    await esperar(3500); // vuelta automatica a grupos
    await pagina.locator('#btnCobrarQr').click();
    await pagina.waitForSelector('#modalQr:not([hidden])', { timeout: 8000 });
    chequear('ventana con el monto', (await pagina.locator('#qrMonto').innerText()).includes('3.450,50'), await pagina.locator('#qrMonto').innerText());
    let ventas = await api('/api/ventas');
    chequear('la venta todavia NO existe', ventas.ventas.length === 0);
    await escanear();
    await esperar(400);
    chequear('con el cobro en curso no entran articulos', (await carritoN()) === 1);

    console.log('\n3. Cancelar');
    await pagina.locator('#qrCancelar').click();
    await pagina.waitForSelector('#modalQr', { state: 'hidden', timeout: 8000 });
    chequear('cancelar cierra la ventana y deja el carrito', (await carritoN()) === 1);
    chequear('sin venta guardada', (await api('/api/ventas')).ventas.length === 0);

    console.log('\n4. Pagar');
    await pagina.locator('#btnCobrarQr').click();
    await pagina.waitForSelector('#modalQr:not([hidden])', { timeout: 8000 });
    const orden = [...mp.ordenes.values()].find((o) => o.status === 'created');
    chequear('hay una orden nueva en la caja', !!orden && orden.total_amount === '3450.50', orden && orden.total_amount);

    console.log('\n5. Recarga en medio del cobro');
    await pagina.reload();
    await pagina.waitForSelector('#modalQr:not([hidden])', { timeout: 10000 });
    chequear('la ventana vuelve sola', (await pagina.locator('#qrMonto').innerText()).includes('3.450,50'));

    orden.status = 'processed';
    await pagina.waitForSelector('#modalQr', { state: 'hidden', timeout: 15000 });
    await pagina.waitForFunction(() => /cobrada por QR/.test(document.querySelector('#avisos').innerText), null, { timeout: 8000 });
    chequear('al acreditarse: ventana cerrada y aviso de venta cobrada', true);
    ventas = await api('/api/ventas');
    chequear('una sola venta, por el total', ventas.ventas.length === 1 && ventas.ventas[0].total_centavos === 345050, JSON.stringify(ventas.ventas.map((v) => v.total_centavos)));
    const det = await api(`/api/ventas/${ventas.ventas[0].id}`);
    chequear('medio de pago qr_mp', det.venta.medio_pago === 'qr_mp');

    console.log('\n6. Pago sin recargar (carrito de esta pantalla)');
    await pagina.reload();
    await pagina.waitForSelector('#vistaGrupos', { timeout: 15000 });
    await pagina.waitForFunction(() => !document.querySelector('#btnCobrarQr').hidden, null, { timeout: 10000 });
    await escanear();
    await pagina.waitForFunction(() => document.querySelector('#total').textContent.includes('3.450'), null, { timeout: 8000 });
    await esperar(3500);
    await pagina.locator('#btnCobrarQr').click();
    await pagina.waitForSelector('#modalQr:not([hidden])', { timeout: 8000 });
    [...mp.ordenes.values()].filter((o) => o.status === 'created').forEach((o) => { o.status = 'processed'; });
    await pagina.waitForSelector('#modalQr', { state: 'hidden', timeout: 15000 });
    await pagina.waitForFunction(() => /guardada · QR/.test(document.querySelector('#avisos').innerText), null, { timeout: 8000 });
    chequear('aviso "guardada · QR" y carrito limpio', (await carritoN()) === 0);
    chequear('dos ventas en total', (await api('/api/ventas')).ventas.length === 2);

    chequear('sin errores de consola/JS', errores.length === 0, errores.join(' | '));
  } catch (e) {
    console.error(e);
    fallos++;
  }

  console.log(fallos ? `\n${fallos} verificación(es) fallaron\n` : '\nTodo OK\n');
  await terminar(fallos ? 1 : 0);
})();
