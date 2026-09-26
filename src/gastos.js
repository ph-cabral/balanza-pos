'use strict';

/**
 * Gastos por proveedor (Administracion -> Ventas).
 *
 * Los gastos se siguen cargando por el bot de Telegram (monto -> Proveedor /
 * Gasto) en la planilla de Google. El POS tiene una copia completa de esa
 * planilla en SQLite (tabla `planilla`, ver sheets-importar.js, se actualiza
 * cada sheets.importarSegundos) y los gastos se leen de ahi: gasto = toda fila
 * cuyo tipo no es "cliente". "Actualizar" en administracion fuerza una lectura
 * de la planilla antes de responder.
 *
 * Se agrupan por proveedor y se pasan a centavos.
 */

function mesValido(m) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
}

/** Agrupa las filas de la planilla por proveedor. Montos en centavos. */
function agrupar(gastos, proveedores) {
  const lista = new Map(); // nombre en minusculas -> nombre como esta en la lista
  for (const p of proveedores || []) lista.set(String(p).trim().toLowerCase(), String(p).trim());

  const porNombre = new Map();
  let pagado = 0;
  let aPagar = 0;
  let cantidad = 0;

  for (const g of gastos || []) {
    const detalle = String(g.detalle || '').trim();
    const centavos = Math.round(Math.abs(Number(g.monto) || 0) * 100);
    if (!detalle || !centavos) continue;
    const clave = detalle.toLowerCase();
    let p = porNombre.get(clave);
    if (!p) {
      p = {
        nombre: lista.get(clave) || detalle,
        es_proveedor: lista.has(clave),
        pagado_centavos: 0,
        a_pagar_centavos: 0,
        cantidad: 0,
        ultimo: null,
        movimientos: [],
      };
      porNombre.set(clave, p);
    }
    const esPagado = g.pagado !== false;
    if (esPagado) { p.pagado_centavos += centavos; pagado += centavos; } else { p.a_pagar_centavos += centavos; aPagar += centavos; }
    p.cantidad++;
    cantidad++;
    const fecha = String(g.fecha || '').slice(0, 10);
    const hora = String(g.hora || '').slice(0, 5);
    if (!p.ultimo || fecha > p.ultimo) p.ultimo = fecha;
    p.movimientos.push({ fecha, hora, monto_centavos: centavos, pagado: esPagado });
  }

  const filas = [...porNombre.values()];
  for (const p of filas) {
    p.total_centavos = p.pagado_centavos + p.a_pagar_centavos;
    p.movimientos.sort((a, b) => (b.fecha + b.hora).localeCompare(a.fecha + a.hora)); // el mas reciente arriba
  }
  // Proveedores de la lista primero; dentro de cada bloque, el de mas gasto arriba.
  filas.sort((a, b) => (b.es_proveedor - a.es_proveedor) ||
    (b.total_centavos - a.total_centavos) || a.nombre.localeCompare(b.nombre, 'es'));

  return {
    total_pagado_centavos: pagado,
    total_a_pagar_centavos: aPagar,
    total_centavos: pagado + aPagar,
    cantidad,
    proveedores: filas,
  };
}

module.exports = function crearGastos(config, planilla) {
  const db = require('./db');
  const sincroniza = () => !!(planilla && planilla.habilitado());

  // Se consideran "habilitados" si la copia de la planilla esta activa o si
  // ya hay una copia guardada (se muestra aunque ahora este apagada).
  const habilitado = () => sincroniza() || db.planillaResumen().movimientos > 0;

  async function delMes(mes, { refrescar = false } = {}) {
    if (refrescar && sincroniza()) await planilla.procesar();

    const r = db.planillaResumen();
    if (!r.movimientos && !r.leida) {
      if (!sincroniza()) return { habilitado: false, mes, motivo: 'Falta sheets.url o sheets.token en config.json' };
      const est = planilla.estado();
      const err = est.ultimo_resultado && est.ultimo_resultado.ok === false ? est.ultimo_resultado : null;
      if (err) return { habilitado: true, mes, error: err.error, codigo: err.codigo || null };
      return { habilitado: true, mes, error: 'Todavía no se leyó la planilla; probá Actualizar en unos segundos', codigo: 'sin-lectura' };
    }

    const filas = db.planillaGastosDelMes(mes).map((g) => ({ ...g, monto: g.monto_centavos / 100 }));
    const datos = { habilitado: true, mes, actualizado: r.leida, ...agrupar(filas, db.planillaProveedores()) };

    // Si la ultima lectura fallo, se muestra lo guardado con el aviso del error.
    const est = sincroniza() ? planilla.estado() : null;
    const res = est && est.ultimo_resultado;
    if (res && res.ok === false) return { ...datos, error: res.error, codigo: res.codigo || null, desactualizado: true };
    return datos;
  }

  return { habilitado, delMes, mesValido };
};

module.exports.agrupar = agrupar;
module.exports.mesValido = mesValido;
