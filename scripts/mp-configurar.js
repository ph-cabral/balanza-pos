'use strict';

/**
 * Alta UNICA de la sucursal y la caja (POS) en Mercado Pago para el QR fijo.
 *
 *   1. En config.json cargar mercadopago.accessToken (credenciales de produccion
 *      de la aplicacion de Mercado Pago Developers).
 *   2. npm run mp-configurar            (crea sucursal + caja y muestra el QR)
 *      npm run mp-configurar -- --guardar   (ademas completa config.json)
 *   3. Imprimir el QR (URL "template_document" o "image") y pegarlo en el mostrador.
 *
 * Si ya existe la caja, no la duplica: usa --caja=<external_id> para reutilizarla.
 */

const fs = require('fs');
const path = require('path');
const crearMercadoPago = require('../src/mercadopago');

const RUTA = process.env.POS_CONFIG || path.join(__dirname, '..', 'config.json');
const args = process.argv.slice(2);
const guardar = args.includes('--guardar');
const arg = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };

const config = JSON.parse(fs.readFileSync(RUTA, 'utf8').replace(/^﻿/, ''));
config.mercadopago = config.mercadopago || {};
if (!config.mercadopago.accessToken) {
  console.error('Falta mercadopago.accessToken en config.json');
  process.exit(1);
}
const mp = crearMercadoPago(config);

(async () => {
  const yo = await mp.pedir('GET', '/users/me');
  const userId = String(yo.id);
  console.log(`Cuenta: ${yo.nickname || yo.email || userId} (user_id ${userId})`);

  const sufijo = arg('sufijo') || 'FIA';
  const storeExt = `${sufijo}SUC001`;
  const posExt = arg('caja') || `${sufijo}SUC001POS001`;

  let store;
  try {
    store = await mp.pedir('POST', `/users/${userId}/stores`, {
      name: arg('nombre') || 'Fiambrería',
      external_id: storeExt,
      location: {
        street_number: arg('numero') || '0',
        street_name: arg('calle') || 'Sin calle',
        city_name: arg('ciudad') || 'Ciudad',
        state_name: arg('provincia') || 'Provincia',
        latitude: Number(arg('lat')) || -34.6037,
        longitude: Number(arg('lng')) || -58.3816,
        reference: 'Mostrador',
      },
    });
    console.log(`Sucursal creada: id ${store.id}`);
  } catch (e) {
    console.error(`No se pudo crear la sucursal: ${e.message}`);
    console.error('Si ya existe, buscá su id en Mercado Pago Developers y corré con --store=<id>.');
    if (!arg('store')) process.exit(1);
  }
  const storeId = arg('store') || store.id;

  const pos = await mp.pedir('POST', '/v2/pos', {
    name: 'Caja mostrador',
    store_id: String(storeId),
    external_id: posExt,
    config: { qr: { operating_mode: 'pdv' } },
  }, true);
  const qr = pos.qr_response || {};
  console.log(`Caja creada: external_id ${pos.external_id || posExt}`);
  console.log(`QR (imagen):   ${qr.image || '(ver en Mercado Pago)'}`);
  console.log(`QR (plantilla PDF para imprimir): ${qr.template_document || '(ver en Mercado Pago)'}`);

  if (guardar) {
    config.mercadopago.userId = userId;
    config.mercadopago.externalPosId = pos.external_id || posExt;
    config.mercadopago.habilitado = true;
    fs.writeFileSync(RUTA, JSON.stringify(config, null, 2) + '\n', 'utf8');
    console.log('config.json actualizado (mercadopago.habilitado = true). Reiniciá el POS.');
  } else {
    console.log(`Para habilitarlo: mercadopago.externalPosId = "${pos.external_id || posExt}" y habilitado = true (o repetir con --guardar).`);
  }
})().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
