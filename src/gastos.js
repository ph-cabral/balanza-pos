'use strict';

/**
 * Gastos por proveedor, leidos de la planilla de Google.
 *
 * Los gastos se siguen cargando por el bot de Telegram (monto -> Proveedor /
 * Gasto), asi que la fuente es la planilla, no SQLite. El POS los pide al
 * mismo webapp de Apps Script al que copia las ventas ("POS -> Planilla",
 * funcion leerGastosPos_), con la misma URL y el mismo token:
 *
 *   POST { accion: 'gastos', token, mes: 'AAAA-MM' }
 *   ->   { ok, mes, gastos: [{ fecha, hora, detalle, monto, pagado }], proveedores: [...] }
 *
 * Aca se agrupan por proveedor y se pasan a centavos. Se guarda en memoria
 * unos minutos por mes para no ir a Google cada vez que se abre la pestaña;
 * "Actualizar" en administracion fuerza la lectura.
 *
 * No depende de sheets.habilitado (eso es la copia de ventas): alcanza con
 * sheets.url y sheets.token. Se apaga con sheets.gastos = false o con
 * POS_SIN_SHEETS=1 (pruebas).
 */

const TIMEOUT_MS = 30000;
const CACHE_MS = 3 * 60 * 1000;

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

module.exports = function crearGastos(config) {
  const cfg = () => config.sheets || {};
  const habilitado = () => process.env.POS_SIN_SHEETS !== '1' &&
    cfg().gastos !== false && !!(cfg().url && cfg().token);

  const cache = new Map(); // mes -> { en, datos }
  const enCurso = new Map(); // mes -> promesa (dos pedidos juntos van a Google una sola vez)

  async function pedir(mes) {
    const r = await fetch(cfg().url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: 'gastos', token: cfg().token, mes }),
      redirect: 'follow', // Apps Script responde con un 302 a googleusercontent
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const texto = await r.text();
    let d;
    try { d = JSON.parse(texto); } catch (_) {
      if (r.status === 404) throw new Error('La URL del webapp de Apps Script no existe (HTTP 404)');
      if (/accounts\.google\.com|ServiceLogin/.test(r.url + texto.slice(0, 2000))) {
        throw new Error('El webapp pide iniciar sesión: "Quién tiene acceso" tiene que ser "Cualquier usuario"');
      }
      throw new Error(`Respuesta no JSON de la planilla (HTTP ${r.status})`);
    }
    if (!d.ok) throw new Error(d.error === 'token invalido' ? 'La planilla rechazó el token (sheets.token ≠ POS_TOKEN)' : (d.error || 'La planilla rechazó el pedido'));
    // Una versión vieja de "POS -> Planilla" no conoce la accion y responde como si fuera un envío de ventas vacío.
    if (!Array.isArray(d.gastos)) {
      const e = new Error('Falta publicar la versión nueva del proyecto "POS → Planilla" en Apps Script ' +
        '(Implementar → Administrar implementaciones → editar → Nueva versión)');
      e.codigo = 'version-vieja';
      throw e;
    }
    return d;
  }

  async function delMes(mes, { refrescar = false } = {}) {
    if (!habilitado()) {
      return { habilitado: false, mes, motivo: 'Falta sheets.url o sheets.token en config.json' };
    }
    const c = cache.get(mes);
    if (!refrescar && c && Date.now() - c.en < CACHE_MS) return c.datos;
    if (enCurso.has(mes)) return enCurso.get(mes);

    const p = (async () => {
      try {
        const d = await pedir(mes);
        const datos = {
          habilitado: true,
          mes,
          actualizado: new Date().toISOString(),
          ...agrupar(d.gastos, d.proveedores),
        };
        cache.set(mes, { en: Date.now(), datos });
        return datos;
      } catch (e) {
        const msg = e.name === 'TimeoutError' ? 'Sin respuesta de Google (timeout)'
          : (e.cause && e.cause.code ? `Sin conexión con Google (${e.cause.code})` : e.message);
        // Si ya habia datos de ese mes, se muestran con el aviso del error.
        if (c) return { ...c.datos, error: msg, desactualizado: true };
        return { habilitado: true, mes, error: msg, codigo: e.codigo || null };
      } finally {
        enCurso.delete(mes);
      }
    })();
    enCurso.set(mes, p);
    return p;
  }

  return { habilitado, delMes, mesValido };
};

module.exports.agrupar = agrupar;
module.exports.mesValido = mesValido;
