'use strict';

/**
 * Cliente minimo de Mercado Pago para cobrar con el QR FIJO de la caja
 * (Orders API, config.qr.mode = "static"). El QR impreso en el mostrador no
 * cambia: el POS le "carga" el monto creando una orden para esa caja y despues
 * consulta la orden hasta que se paga, se cancela o vence.
 *
 * Credenciales solo en config.json (no va a git): mercadopago.accessToken.
 * POS_MP_BASE permite apuntar las pruebas a un servidor falso.
 */

const crypto = require('crypto');

const BASE = () => process.env.POS_MP_BASE || 'https://api.mercadopago.com';
const TIMEOUT_MS = 10000;

/** 12500 centavos -> "125.00" (la API recibe montos como string decimal). */
function monto(centavos) {
  return (Math.round(centavos) / 100).toFixed(2);
}

/** "125.00" -> 12500 centavos. NaN si no es un numero. */
function centavos(texto) {
  return Math.round(Number(texto) * 100);
}

/** Estado de la orden de MP -> estado del cobro en el POS. */
function interpretar(orden) {
  switch (orden && orden.status) {
    case 'processed': return 'pagado';
    case 'refunded': return 'reembolsado';
    case 'canceled': return 'cancelado';
    case 'expired': return 'vencido';
    default: return 'pendiente'; // created / at_terminal / desconocido: seguir esperando
  }
}

module.exports = function crearMercadoPago(config) {
  const cfg = () => config.mercadopago || {};

  const habilitado = () => process.env.POS_SIN_MP !== '1' &&
    !!(cfg().habilitado && cfg().accessToken && (cfg().externalPosId || cfg().cajas));

  /** Caja (external_id del POS de MP) que corresponde a una estacion. */
  function posId(estacionId) {
    const c = cfg();
    return (c.cajas && estacionId && c.cajas[estacionId]) || c.externalPosId || null;
  }

  async function pedir(metodo, ruta, cuerpo, conClave) {
    const headers = { Authorization: `Bearer ${cfg().accessToken}`, Accept: 'application/json' };
    if (cuerpo) headers['Content-Type'] = 'application/json';
    // Crear/cancelar exigen clave de idempotencia: reintentar no duplica la orden.
    if (conClave) headers['X-Idempotency-Key'] = crypto.randomUUID();

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let r;
    try {
      r = await fetch(BASE() + ruta, {
        method: metodo, headers, body: cuerpo ? JSON.stringify(cuerpo) : undefined, signal: ctl.signal,
      });
    } catch (e) {
      const err = new Error(e.name === 'AbortError' ? 'Mercado Pago no respondió' : `Sin conexión con Mercado Pago (${e.message})`);
      err.red = true;
      throw err;
    } finally {
      clearTimeout(t);
    }

    const texto = await r.text();
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch (_) { /* respuesta no JSON */ }
    if (!r.ok) {
      const e0 = json && Array.isArray(json.errors) && json.errors[0];
      const err = new Error((e0 && (e0.message || e0.code)) || (json && json.message) || `Mercado Pago respondió ${r.status}`);
      err.status = r.status;
      err.codigo = (e0 && e0.code) || (json && json.error) || '';
      throw err;
    }
    return json;
  }

  /** Crea la orden en la caja: el QR fijo pasa a mostrar este monto. */
  async function crearOrden({ referencia, totalCentavos, descripcion, posId: caja }) {
    const total = monto(totalCentavos);
    const minutos = Math.max(1, Math.min(180, Math.round(Number(cfg().expiracionMinutos) || 5)));
    const o = await pedir('POST', '/v1/orders', {
      type: 'qr',
      external_reference: referencia,
      description: descripcion || 'Venta',
      expiration_time: `PT${minutos}M`,
      total_amount: total,
      config: { qr: { external_pos_id: caja, mode: 'static' } },
      items: [{ title: descripcion || 'Venta', unit_price: total, quantity: 1, unit_measure: 'unit' }],
      transactions: { payments: [{ amount: total }] },
    }, true);
    if (!o || !o.id) throw new Error('Mercado Pago no devolvió el id de la orden');
    return { id: o.id, status: o.status, minutos };
  }

  const consultarOrden = (id) => pedir('GET', `/v1/orders/${encodeURIComponent(id)}`);
  const cancelarOrden = (id) => pedir('POST', `/v1/orders/${encodeURIComponent(id)}/cancel`, null, true);

  return { config: cfg, habilitado, posId, crearOrden, consultarOrden, cancelarOrden, interpretar, monto, centavos, pedir };
};

module.exports.monto = monto;
module.exports.centavos = centavos;
module.exports.interpretar = interpretar;
