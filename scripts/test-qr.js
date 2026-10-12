'use strict';

/**
 * Prueba del cobro con el QR fijo de Mercado Pago, con un Mercado Pago simulado:
 *   - sin configurar: apagado, no hay cobro
 *   - crear cobro: orden con monto en string, tipo qr, modo static, caja y clave de idempotencia
 *   - la venta NO existe hasta que MP la da por pagada
 *   - consultas repetidas mientras esta pendiente: no guardan nada, cache de 1,5 s
 *   - pagado: venta guardada UNA vez (medio_pago qr_mp, descuento aplicado), idempotente
 *   - segundo cobro con otro en curso en la misma caja -> 409
 *   - `reemplaza`: el POS cambia el carrito y la orden propia se cancela y se crea otra (o devuelve el pago si justo se pagó)
 *   - cancelar / vencido / monto distinto / MP caido
 *   - barrido del servidor: la venta se guarda aunque nadie consulte
 *   - reinicio del POS con un cobro pendiente: se retoma
 *
 * No toca MP ni la base real: config y base temporales, puerto 3061.
 *
 *   npm run test-qr
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const PUERTO = 3061;
const URL = `http://localhost:${PUERTO}`;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let fallos = 0;
function chequear(desc, cond, detalle) {
  if (!cond) fallos++;
  console.log(`  ${cond ? 'OK  ' : 'MAL '} ${desc}${detalle !== undefined ? '  -> ' + detalle : ''}`);
}

// --- Mercado Pago simulado ---------------------------------------------------
function crearMP() {
  const m = { ordenes: new Map(), pedidos: [], caido: false, n: 0 };
  m.server = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; });
    req.on('end', () => {
      m.pedidos.push({ metodo: req.method, url: req.url, headers: req.headers, body: cuerpo ? JSON.parse(cuerpo) : null });
      const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (m.caido) return json(503, { message: 'caido' });
      if (req.headers.authorization !== 'Bearer TOKEN-PRUEBA') return json(401, { message: 'token invalido' });
      if (req.method === 'POST' && req.url === '/v1/orders') {
        const b = JSON.parse(cuerpo);
        if (!req.headers['x-idempotency-key']) return json(400, { errors: [{ code: 'idempotency_key_required', message: 'falta clave' }] });
        if (b.config.qr.external_pos_id !== 'CAJA1') return json(404, { errors: [{ code: 'pos_not_found', message: 'pos_not_found' }] });
        const id = `ORD${++m.n}`;
        m.ordenes.set(id, { id, status: 'created', total_amount: b.total_amount, external_reference: b.external_reference });
        return json(201, m.ordenes.get(id));
      }
      let r = req.url.match(/^\/v1\/orders\/([^/]+)$/);
      if (req.method === 'GET' && r) {
        const o = m.ordenes.get(r[1]);
        return o ? json(200, o) : json(404, { message: 'no existe' });
      }
      r = req.url.match(/^\/v1\/orders\/([^/]+)\/cancel$/);
      if (req.method === 'POST' && r) {
        const o = m.ordenes.get(r[1]);
        if (!o) return json(404, { message: 'no existe' });
        if (o.status !== 'created') return json(409, { errors: [{ code: 'cannot_cancel_order', message: 'No se puede cancelar' }] });
        o.status = 'canceled';
        return json(200, o);
      }
      json(404, { message: 'ruta' });
    });
  });
  return m;
}

(async () => {
  const mp = crearMP();
  await new Promise((r) => mp.server.listen(0, r));
  const mpPuerto = mp.server.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-qr-'));
  const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.example.json'), 'utf8'));
  cfg.http.port = PUERTO;
  for (const b of cfg.balanzas) b.simulador = true;
  cfg.sheets = { habilitado: false, importar: false };
  const ruta = path.join(dir, 'config.json');
  const escribirCfg = (mpCfg) => { cfg.mercadopago = mpCfg; cfg.mediosPago = { qr: 0, tarjeta: 0 }; fs.writeFileSync(ruta, JSON.stringify(cfg)); };
  const env = { ...process.env, POS_CONFIG: ruta, POS_DATA: dir, POS_CONFIG_COMUN: path.join(dir, 'no-existe.json'), POS_MP_BASE: `http://localhost:${mpPuerto}`, POS_SIN_SHEETS: '1' };

  let servidor = null;
  const arrancar = async () => {
    servidor = spawn(process.execPath, [path.join(RAIZ, 'src', 'server.js')], { stdio: ['ignore', 'ignore', 'inherit'], env });
    for (let i = 0; i < 50; i++) {
      try { await fetch(URL + '/api/red'); return; } catch (_) { await esperar(200); }
    }
  };
  const parar = async () => { try { servidor.kill(); } catch (_) {} await esperar(400); };
  const terminar = async (codigo) => {
    await parar();
    try { mp.server.close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    process.exit(codigo);
  };
  const ord = (idCobro) => [...mp.ordenes.values()].find((o) => o.external_reference === idCobro);
  const get = (r) => fetch(URL + r).then((x) => x.json());
  const post = (r, b) => fetch(URL + r, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) })
    .then(async (x) => ({ http: x.status, ...(await x.json()) }));

  try {
    console.log('\n1. Sin configurar');
    escribirCfg({ habilitado: false });
    await arrancar();
    let e = await get('/api/cobros-qr/estado');
    chequear('estado: habilitado false', e.ok && e.habilitado === false);
    const unidad = (await post('/api/productos', { nombre: 'Gaseosa 2L', tipo: 'unidad', precio_centavos: 345050 })).producto;
    chequear('producto de prueba creado', !!unidad && unidad.precio_centavos === 345050);
    const items = [{ producto_id: unidad.id, tipo: 'unidad', cantidad: 2 }];
    let r = await post('/api/cobros-qr', { items });
    chequear('crear cobro con MP apagado -> 400', r.http === 400 && !r.ok, r.error);

    console.log('\n2. Crear cobro');
    await parar();
    escribirCfg({ habilitado: true, accessToken: 'TOKEN-PRUEBA', externalPosId: 'CAJA1', expiracionMinutos: 7, consultaSegundos: 3 });
    await arrancar();
    e = await get('/api/cobros-qr/estado');
    chequear('estado: habilitado + segundos de consulta', e.habilitado === true && e.consulta_segundos === 3);
    const totalEsperado = unidad.precio_centavos * 2;
    r = await post('/api/cobros-qr', { items, estacion: 'e1' });
    chequear('cobro creado pendiente con el total correcto', r.ok && r.cobro.estado === 'pendiente' && r.cobro.total_centavos === totalEsperado, JSON.stringify(r.cobro));
    const o = mp.pedidos.find((p) => p.metodo === 'POST' && p.url === '/v1/orders');
    const b = o && o.body;
    chequear('orden: type qr, modo static, caja, expiracion PT7M', b && b.type === 'qr' && b.config.qr.mode === 'static' && b.config.qr.external_pos_id === 'CAJA1' && b.expiration_time === 'PT7M');
    chequear('orden: monto como string decimal y referencia = id del cobro', b && b.total_amount === (totalEsperado / 100).toFixed(2) && b.external_reference === r.cobro.id, b && b.total_amount);
    chequear('orden: lleva X-Idempotency-Key', !!(o && o.headers['x-idempotency-key']));
    const id1 = r.cobro.id;

    console.log('\n3. Pendiente: no hay venta');
    const antesPed = mp.pedidos.length;
    let c = await get(`/api/cobros-qr/${id1}`);
    chequear('consulta -> pendiente, sin venta', c.ok && c.cobro.estado === 'pendiente' && !c.venta);
    await get(`/api/cobros-qr/${id1}`);
    chequear('dos consultas seguidas = un pedido a MP (cache)', mp.pedidos.length - antesPed === 1, `${mp.pedidos.length - antesPed}`);
    const r2 = await post('/api/cobros-qr', { items });
    chequear('otro cobro en la misma caja -> 409', r2.http === 409, r2.error);

    console.log('\n4. Pagado');
    ord(id1).status = 'processed';
    await esperar(1700);
    c = await get(`/api/cobros-qr/${id1}`);
    chequear('consulta -> pagado + venta', c.ok && c.cobro.estado === 'pagado' && c.venta && c.venta.total_centavos === totalEsperado, JSON.stringify(c.cobro));
    const ventaId = c.venta && c.venta.id;
    await esperar(1700);
    c = await get(`/api/cobros-qr/${id1}`);
    chequear('consultar de nuevo no duplica la venta', c.cobro.estado === 'pagado' && c.cobro.venta_id === ventaId);
    const det = await get(`/api/ventas/${ventaId}`);
    chequear('la venta guarda items, total y medio de pago qr_mp', det.ok && det.venta.total_centavos === totalEsperado && det.venta.items.length === 1 && det.venta.medio_pago === 'qr_mp' && det.venta.estacion === 'Mostrador 1', JSON.stringify(det.venta));
    const lista = await get('/api/ventas');
    const cuantas = (lista.ventas || []).filter((v) => v.id === ventaId).length;
    chequear('aparece una sola vez en el listado', cuantas === 1);

    console.log('\n4b. Con descuento');
    const d10 = (await post('/api/descuentos', { nombre: 'Jubilados', tipo: 'porcentaje', valor: 10 })).descuento;
    const itemsD = [{ producto_id: unidad.id, tipo: 'unidad', cantidad: 1 }];
    const dto = await get('/api/descuentos');
    const did = (d10 && d10.id) || dto.descuentos[0].id;
    r = await post('/api/cobros-qr', { items: itemsD, estacion: 'e1', descuento_id: did });
    const neto = Math.ceil((345050 * 90) / 1000000) * 10000; // neto redondeado para arriba a $100
    chequear('el cobro lleva el total NETO (con descuento)', r.ok && r.cobro.total_centavos === neto, `${r.cobro && r.cobro.total_centavos} vs ${neto}`);
    const idD = r.cobro.id;
    ord(idD).status = 'processed';
    await esperar(1700);
    c = await get(`/api/cobros-qr/${idD}`);
    chequear('pagado con descuento -> venta con descuento guardado', c.cobro.estado === 'pagado' && c.venta && c.venta.descuento_centavos === 345050 - neto, JSON.stringify(c.venta));

    console.log('\n4c. Reemplazar la propia orden (el carrito cambió)');
    const itemsA = [{ producto_id: unidad.id, tipo: 'unidad', cantidad: 1 }];
    const itemsB = [{ producto_id: unidad.id, tipo: 'unidad', cantidad: 3 }];
    r = await post('/api/cobros-qr', { items: itemsA, estacion: 'e1' });
    const idA = r.cobro.id;
    let rr = await post('/api/cobros-qr', { items: itemsB, estacion: 'otra', reemplaza: 'ajeno' });
    chequear('reemplaza con un id que no es el de la caja -> 409', rr.http === 409, rr.error);
    rr = await post('/api/cobros-qr', { items: itemsB, estacion: 'e1', reemplaza: idA });
    const idB = rr.cobro && rr.cobro.id;
    chequear('reemplaza: anterior cancelada en MP, nueva pendiente con el total nuevo',
      rr.ok && idB !== idA && ord(idA).status === 'canceled' && ord(idB).status === 'created' && rr.cobro.total_centavos === 345050 * 3, JSON.stringify(rr.cobro));
    ord(idB).status = 'processed';
    rr = await post('/api/cobros-qr', { items: itemsA, estacion: 'e1', reemplaza: idB });
    chequear('si la anterior se pagó justo: devuelve ese pago con su venta y no crea otra orden',
      rr.ok && rr.cobro.id === idB && rr.cobro.estado === 'pagado' && !!rr.venta && [...mp.ordenes.values()].filter((o) => o.status === 'created').length === 0, JSON.stringify(rr.cobro));

    console.log('\n5. Cancelar');
    r = await post('/api/cobros-qr', { items });
    const id2 = r.cobro.id;
    let x = await post(`/api/cobros-qr/${id2}/cancelar`);
    chequear('cancelar -> cancelado, sin venta', x.ok && x.cobro.estado === 'cancelado' && ord(id2).status === 'canceled');
    r = await post('/api/cobros-qr', { items });
    chequear('despues de cancelar se puede cobrar de nuevo', r.ok && r.cobro.estado === 'pendiente');
    const id3 = r.cobro.id;

    console.log('\n6. Pagado justo antes de cancelar');
    ord(id3).status = 'processed';
    x = await post(`/api/cobros-qr/${id3}/cancelar`);
    chequear('cancelar un cobro ya pagado -> devuelve pagado + venta', x.ok && x.cobro.estado === 'pagado' && !!x.venta, JSON.stringify(x.cobro));

    console.log('\n7. Vencido y monto distinto');
    r = await post('/api/cobros-qr', { items });
    const id4 = r.cobro.id;
    ord(id4).status = 'expired';
    await esperar(1700);
    c = await get(`/api/cobros-qr/${id4}`);
    chequear('orden vencida -> vencido, sin venta', c.cobro.estado === 'vencido' && !c.venta);
    r = await post('/api/cobros-qr', { items });
    const id5 = r.cobro.id;
    Object.assign(ord(id5), { status: 'processed', total_amount: '1.00' });
    await esperar(1700);
    c = await get(`/api/cobros-qr/${id5}`);
    chequear('pagado por otro monto -> no guarda venta y avisa', c.cobro.estado === 'pendiente' && /no coincide/.test(c.aviso || ''), c.aviso);
    ord(id5).status = 'canceled';
    await esperar(1700);
    await get(`/api/cobros-qr/${id5}`);

    console.log('\n8. Mercado Pago caido');
    mp.caido = true;
    x = await post('/api/cobros-qr', { items });
    chequear('crear con MP caido -> 502 con mensaje claro', x.http === 502 && /caido|Mercado Pago/i.test(x.error || ''), `${x.http} ${x.error}`);
    mp.caido = false;
    r = await post('/api/cobros-qr', { items });
    chequear('el intento fallido no deja la caja trabada', r.ok && r.cobro.estado === 'pendiente', r.error);
    const id6 = r.cobro.id;
    mp.caido = true;
    await esperar(1700);
    c = await get(`/api/cobros-qr/${id6}`);
    chequear('MP caido durante la espera -> sigue pendiente con aviso (no error)', c.ok && c.cobro.estado === 'pendiente' && !!c.aviso, c.aviso);
    mp.caido = false;

    console.log('\n9. Barrido del servidor y reinicio');
    ord(id6).status = 'processed';
    await parar();
    await arrancar(); // el pendiente sobrevive al reinicio; nadie lo consulta desde la pantalla
    for (let i = 0; i < 35; i++) {
      c = await get(`/api/cobros-qr/${id6}`);
      if (c.cobro.estado === 'pagado') break;
      await esperar(1000);
    }
    chequear('cobro pendiente tras reinicio -> pagado y con venta', c.cobro.estado === 'pagado' && !!c.cobro.venta_id, JSON.stringify(c.cobro));

    console.log('\n10. Items invalidos');
    x = await post('/api/cobros-qr', { items: [] });
    chequear('sin items -> 400 y no crea orden', x.http === 400 && !x.ok, x.error);
    x = await post('/api/cobros-qr', { items, descuento_id: 99999 });
    chequear('descuento inexistente -> 400', x.http === 400 && /descuento/i.test(x.error || ''), x.error);
    x = await get('/api/cobros-qr/no-existe');
    chequear('cobro inexistente -> 404', x.ok === false);
  } catch (err) {
    console.error(err);
    fallos++;
  }

  console.log(fallos ? `\n${fallos} verificación(es) fallaron\n` : '\nTodo OK\n');
  await terminar(fallos ? 1 : 0);
})();
