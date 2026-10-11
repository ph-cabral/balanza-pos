'use strict';

/**
 * Cobro con el QR fijo de Mercado Pago.
 *
 *  POST /api/cobros-qr              {items, estacion, descuento_id} -> crea el cobro y la orden en la caja
 *  GET  /api/cobros-qr/estado       -> {habilitado}
 *  GET  /api/cobros-qr/:id          -> consulta a MP; si se pagó, guarda la venta (una sola vez)
 *  POST /api/cobros-qr/:id/cancelar -> cancela la orden (si ya se pagó, devuelve el pago)
 *
 * La venta se guarda SOLO al confirmarse el pago. Si la tablet se cae a mitad de
 * cobro, un barrido del servidor sigue consultando las ordenes pendientes.
 */

const express = require('express');
const crypto = require('crypto');
const db = require('./db');

const BARRIDO_MS = 20000;   // cada cuanto el servidor revisa pendientes por su cuenta
const CACHE_MS = 1500;      // varias consultas seguidas del mismo cobro = una sola a MP

module.exports = function crearCobrosQr({ mp, estaciones, sheets }) {
  const router = express.Router();
  const ok = (res, data) => res.json({ ok: true, ...data });
  const fallo = (res, code, mensaje) => res.status(code).json({ ok: false, error: mensaje });

  const cache = new Map(); // id -> {t, p}: promesa de la consulta en curso/reciente

  function resumen(c, extra = {}) {
    return { id: c.id, estado: c.estado, total_centavos: c.total_centavos, venta_id: c.venta_id || null, ...extra };
  }

  /** Consulta MP y deja el cobro al dia. Devuelve {cobro, venta?, aviso?}. */
  async function refrescar(id) {
    let c = db.cobroQr(id);
    if (!c) return null;
    if (c.estado === 'pagado' || !c.order_id) return { cobro: c };

    let orden;
    try {
      orden = await mp.consultarOrden(c.order_id);
    } catch (e) {
      // Sin red o MP caido: el cobro sigue como estaba, el POS vuelve a preguntar.
      return { cobro: db.cobroQr(id), aviso: e.red ? e.message : `Mercado Pago: ${e.message}` };
    }

    // Otra consulta pudo resolverlo mientras esperabamos la respuesta.
    c = db.cobroQr(id);
    if (c.estado === 'pagado') return { cobro: c };

    const nuevo = mp.interpretar(orden);
    if (nuevo === 'pagado') {
      const esperado = c.total_centavos;
      const recibido = orden.total_amount != null ? mp.centavos(orden.total_amount) : esperado;
      if (recibido !== esperado) {
        return { cobro: c, aviso: `El monto pagado (${mp.monto(recibido)}) no coincide con el de la venta (${mp.monto(esperado)}). Revisar en Mercado Pago.` };
      }
      const aSheets = !!(sheets && sheets.habilitado());
      const r = db.confirmarCobroQr(id, { sheets: aSheets });
      if (r.nuevo && aSheets) sheets.avisarVentaNueva();
      return { cobro: db.cobroQr(id), venta: r.venta || null };
    }
    if (nuevo !== 'pendiente') db.cerrarCobroQr(id, nuevo);
    return { cobro: db.cobroQr(id) };
  }

  function refrescarCacheado(id) {
    const e = cache.get(id);
    if (e && Date.now() - e.t < CACHE_MS) return e.p;
    const p = refrescar(id);
    cache.set(id, { t: Date.now(), p });
    p.finally(() => { if (cache.size > 50) cache.clear(); }).catch(() => {});
    return p;
  }

  router.get('/estado', (_req, res) => ok(res, {
    habilitado: mp.habilitado(),
    consulta_segundos: Math.max(2, Number((mp.config() || {}).consultaSegundos) || 3),
  }));

  router.post('/', async (req, res) => {
    if (!mp.habilitado()) return fallo(res, 400, 'El cobro por QR no está habilitado');
    let id = null;
    try {
      const items = req.body.items || [];
      const est = req.body.estacion ? estaciones.estacion(req.body.estacion) : null;
      const opciones = { descuento_id: req.body.descuento_id || null };
      let total;
      try {
        total = db.totalVenta(items, opciones).total_centavos; // valida items y descuento
      } catch (e) {
        return fallo(res, 400, e.message);
      }
      if (total <= 0) return fallo(res, 400, 'El total de la venta es cero');

      const caja = mp.posId(est && est.id);
      if (!caja) return fallo(res, 400, 'Esta estación no tiene caja de Mercado Pago configurada');

      // El QR fijo muestra una sola orden por vez: si hay otra en curso, no se pisa.
      const previo = db.cobroQrPendienteDeCaja(caja);
      if (previo) {
        const r = await refrescar(previo.id);
        if (r && r.cobro.estado === 'pendiente') {
          return fallo(res, 409, 'Ya hay un cobro por QR en curso en esta caja. Esperá a que termine o cancelalo.');
        }
      }

      id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
      db.crearCobroQr({
        id, pos_id: caja, total_centavos: total,
        payload: { items, estacion: est ? { id: est.id, nombre: est.nombre } : null, descuento_id: opciones.descuento_id },
      });
      const orden = await mp.crearOrden({ referencia: id, totalCentavos: total, descripcion: 'Venta fiambrería', posId: caja });
      db.cobroQrOrden(id, orden.id);
      ok(res, { cobro: resumen(db.cobroQr(id), { minutos: orden.minutos }) });
    } catch (e) {
      if (id) db.cerrarCobroQr(id, 'cancelado');
      fallo(res, e.status && e.status < 500 ? 400 : 502, e.message);
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const r = await refrescarCacheado(req.params.id);
      if (!r) return fallo(res, 404, 'Cobro inexistente');
      ok(res, { cobro: resumen(r.cobro), venta: r.venta || null, aviso: r.aviso || null });
    } catch (e) {
      fallo(res, 500, e.message);
    }
  });

  router.post('/:id/cancelar', async (req, res) => {
    try {
      const c = db.cobroQr(req.params.id);
      if (!c) return fallo(res, 404, 'Cobro inexistente');
      if (c.estado === 'pendiente' && c.order_id) {
        try {
          await mp.cancelarOrden(c.order_id);
          db.cerrarCobroQr(c.id, 'cancelado');
        } catch (e) {
          // Puede que justo se haya pagado: mirar el estado real antes de dar error.
          cache.delete(c.id);
          const r = await refrescar(c.id);
          if (r.cobro.estado === 'pendiente') return fallo(res, 502, `No se pudo cancelar: ${e.message}`);
          return ok(res, { cobro: resumen(r.cobro), venta: r.venta || null });
        }
      } else if (c.estado === 'pendiente') {
        db.cerrarCobroQr(c.id, 'cancelado');
      }
      cache.delete(c.id);
      ok(res, { cobro: resumen(db.cobroQr(c.id)), venta: null });
    } catch (e) {
      fallo(res, 500, e.message);
    }
  });

  // Barrido: si la tablet se apagó, el pago igual se registra.
  const timer = setInterval(async () => {
    if (!mp.habilitado()) return;
    for (const id of db.cobrosQrPendientes()) {
      try { await refrescar(id); } catch (_) { /* se reintenta en el proximo barrido */ }
    }
  }, BARRIDO_MS);
  timer.unref();

  return router;
};
