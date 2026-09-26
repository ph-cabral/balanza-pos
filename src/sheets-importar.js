'use strict';

/**
 * Importa a SQLite las ventas cargadas por el bot de Telegram en la planilla
 * (quienes todavia no usan el POS con balanza siguen anotando ahi). Es el
 * sentido inverso de sheets.js (que copia las ventas del POS a la planilla).
 *
 * Pide al mismo webapp de Apps Script ("POS -> Planilla") todas las filas
 * "cliente" de todas las hojas (accion 'ventas'; ver leerVentasPos_ en
 * apps-script-pos/Codigo.gs) y las guarda como ventas con origen = 'sheet',
 * con un solo item generico con el total (la planilla no tiene detalle por
 * articulo). No hay id de fila en la planilla: la clave de deduplicacion es
 * fecha|hora|monto_centavos|n-esima ocurrencia igual (asi dos ventas iguales
 * en el mismo minuto no se confunden entre si). Correr esto muchas veces no
 * duplica nada: antes de guardar se descarta lo que ya esta en
 * sheets_importadas. La primera corrida (cuando esa tabla esta vacia) trae
 * sola toda la historia que haya en la planilla.
 *
 * No depende de sheets.habilitado (esa es la copia de ventas del POS hacia la
 * planilla): alcanza con sheets.url y sheets.token. Se apaga con
 * config.json -> sheets.importar = false o con POS_SIN_SHEETS=1 (pruebas).
 */

const db = require('./db');

const TIMEOUT_MS = 30000;

// Arma la clave de deduplicacion: como la planilla no tiene un id por fila,
// dos ventas con la misma fecha, hora y monto se distinguen por el orden en
// que aparecen en la lectura (estable: la planilla siempre llega ordenada
// por fecha y hora, y el orden entre iguales no cambia de una lectura a otra).
function conClaves(ventas) {
  const vistos = new Map();
  return ventas.map((v) => {
    const centavos = Math.round(Number(v.monto) * 100);
    const base = `${v.fecha}|${v.hora}|${centavos}`;
    const n = (vistos.get(base) || 0) + 1;
    vistos.set(base, n);
    return { fecha: v.fecha, hora: v.hora, total_centavos: centavos, clave: `${base}|${n}` };
  });
}

module.exports = function crearSheetsImportar(config) {
  const cfg = () => config.sheets || {};
  const habilitado = () => process.env.POS_SIN_SHEETS !== '1' &&
    cfg().importar !== false && !!(cfg().url && cfg().token);

  let enCurso = false;
  let pedidoMientras = false;
  let ultimoIntento = null;
  let ultimoResultado = null;
  let timer = null;

  async function pedir() {
    const r = await fetch(cfg().url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: 'ventas', token: cfg().token }),
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
    // Una version vieja de "POS -> Planilla" no conoce la accion 'ventas'.
    if (!Array.isArray(d.ventas)) {
      const e = new Error('Falta publicar la versión nueva del proyecto "POS → Planilla" en Apps Script ' +
        '(Implementar → Administrar implementaciones → editar → Nueva versión)');
      e.codigo = 'version-vieja';
      throw e;
    }
    return d.ventas;
  }

  async function procesar() {
    if (!habilitado()) return;
    if (enCurso) { pedidoMientras = true; return; }
    enCurso = true;
    ultimoIntento = new Date().toISOString();
    try {
      const crudas = await pedir();
      const conClave = conClaves(crudas).filter((v) => v.total_centavos > 0);
      const yaImportadas = db.sheetsImportadaClaves();
      const nuevas = conClave.filter((v) => !yaImportadas.has(v.clave));
      let importadas = 0;
      for (const v of nuevas) {
        db.importarVentaDeSheet({
          fecha: `${v.fecha} ${v.hora}:00`,
          total_centavos: v.total_centavos,
          clave: v.clave,
        });
        importadas++;
      }
      ultimoResultado = { ok: true, leidas: conClave.length, importadas };
      if (importadas) console.log(`  [sheets] ${importadas} venta(s) importada(s) de la planilla`);
    } catch (e) {
      const msg = e.name === 'TimeoutError' ? 'Sin respuesta de Google (timeout)' : e.message;
      ultimoResultado = { ok: false, error: msg, codigo: e.codigo || null };
      console.warn(`  [sheets] no se pudo importar de la planilla: ${msg}`);
    } finally {
      enCurso = false;
      if (pedidoMientras) { pedidoMientras = false; setImmediate(() => procesar().catch(() => {})); }
    }
  }

  function iniciar() {
    if (timer) clearInterval(timer);
    const seg = Math.max(30, Number(cfg().importarSegundos) || 600);
    timer = setInterval(() => { procesar().catch(() => {}); }, seg * 1000);
    timer.unref();
    if (habilitado()) procesar().catch(() => {});
  }

  function detener() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function estado() {
    return {
      habilitado: habilitado(),
      ...db.sheetsImportadasResumen(),
      ultimo_intento: ultimoIntento,
      ultimo_resultado: ultimoResultado,
    };
  }

  return { habilitado, procesar, iniciar, detener, estado };
};

module.exports.conClaves = conClaves;
