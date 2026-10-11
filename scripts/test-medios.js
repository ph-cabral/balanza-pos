'use strict';

/**
 * Medios de pago: los precios del catalogo son de efectivo; QR y tarjeta suman un
 * porcentaje (config.mediosPago) sobre el neto, redondeado para arriba a $100.
 * Base temporal, sin servidor.
 *
 *   npm run test-medios
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-medios-'));
process.env.POS_DATA = dir;
const db = require('../src/db');

let fallas = 0;
function chequear(nombre, ok, detalle) {
  console.log(`${ok ? 'OK  ' : 'FALLA'} ${nombre}${!ok && detalle ? ' -> ' + detalle : ''}`);
  if (!ok) fallas++;
}

db.configurarMedios({ qr: 1, tarjeta: 10.5 });
const p = db.crearProducto({ nombre: 'Caja de prueba', tipo: 'unidad', precio_centavos: 4000000 });
const items = [{ producto_id: p.id, cantidad: 1, tipo: 'unidad' }];
const t = (medio, extra) => db.totalVenta(items, { medio_pago: medio, ...extra });

chequear('efectivo $40.000', t('').total_centavos === 4000000, t('').total_centavos);
chequear('QR 1 % -> $40.400', t('qr_mp').total_centavos === 4040000, t('qr_mp').total_centavos);
chequear('tarjeta 10,5 % -> $44.200', t('tarjeta').total_centavos === 4420000, t('tarjeta').total_centavos);
chequear('ajuste de tarjeta $4.200', t('tarjeta').ajuste_medio_centavos === 420000);

// Redondeo para arriba a $100: 3.315 x 1,105 = 3.663,075 -> 3.700
const q = db.crearProducto({ nombre: 'Cosa', tipo: 'unidad', precio_centavos: 331500 });
chequear('redondea para arriba a $100', db.totalVenta([{ producto_id: q.id, cantidad: 1, tipo: 'unidad' }], { medio_pago: 'tarjeta' }).total_centavos === 370000);

// El descuento va primero y el medio se aplica sobre el neto.
const d = db.crearDescuento({ nombre: '10 %', tipo: 'porcentaje', valor: 10 });
chequear('descuento + tarjeta', t('tarjeta', { descuento_id: d.id }).total_centavos === 3980000 && t('', { descuento_id: d.id }).total_centavos === 3600000, t('tarjeta', { descuento_id: d.id }).total_centavos);

let msg = '';
try { t('cripto'); } catch (e) { msg = e.message; }
chequear('medio inexistente se rechaza', /Medio de pago invalido/.test(msg), msg);

const v = db.guardarVenta(items, { medio_pago: 'tarjeta' });
const det = db.ventaPorId(v.id);
chequear('venta guarda total, medio y ajuste', det.total_centavos === 4420000 && det.medio_pago === 'tarjeta' && det.ajuste_medio_centavos === 420000, JSON.stringify(det));
chequear('items sin recargo (snapshot de efectivo)', det.items[0].subtotal_centavos === 4000000);
const ve = db.guardarVenta(items, {});
chequear('efectivo sin ajuste', db.ventaPorId(ve.id).total_centavos === 4000000 && db.ventaPorId(ve.id).ajuste_medio_centavos === 0);

// Configuracion: se puede cambiar y tener valores invalidos
db.configurarMedios({ qr: 0, tarjeta: 15 });
chequear('config: tarjeta 15 % -> $46.000', t('tarjeta').total_centavos === 4600000 && t('qr_mp').total_centavos === 4000000);
db.configurarMedios({ qr: 'x' });
chequear('config invalida -> valores por defecto', t('qr_mp').total_centavos === 4040000 && t('tarjeta').total_centavos === 4420000);
chequear('listarMedios', db.listarMedios().map((m) => m.clave).join() === 'efectivo,qr,tarjeta');

db.db.close();
fs.rmSync(dir, { recursive: true, force: true });
if (fallas) { console.log(`\n${fallas} falla(s)`); process.exit(1); }
console.log('\nTodo OK');
