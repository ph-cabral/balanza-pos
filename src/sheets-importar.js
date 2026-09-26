'use strict';

/**
 * Copia la planilla de Google entera a SQLite, para que la base del POS tenga
 * la misma informacion que la planilla. Es el sentido inverso de sheets.js
 * (que copia las ventas del POS a la planilla).
 *
 * Pide al webapp de Apps Script ("POS -> Planilla") TODAS las filas de TODAS
 * las hojas de movimientos, de cualquier tipo, y la lista de proveedores
 * (accion 'planilla'; ver leerPlanillaPos_ en apps-script-pos/Codigo.gs). Con
 * eso, en una sola transaccion (db.sincronizarPlanilla):
 *
 *  - reemplaza la tabla `planilla` (una sola tabla: la division mes en curso
 *    / hoja anual es de la planilla, aca no hace falta) y
 *    `planilla_proveedores`. De ahi salen los gastos por proveedor.
 *  - concilia las ventas: cada fila "cliente" que no escribio este POS (las
 *    que carga el bot de Telegram) queda como venta con origen 'sheet' y un
 *    item generico con el total. Las que ya no estan en la planilla (el bot
 *    las reclasifico como proveedor/gasto o las elimino) se borran. Las que
 *    escribio este POS no se vuelven a traer: se descuentan contando las
 *    ventas propias ya copiadas con la misma fecha, hora y monto.
 *
 * La planilla no tiene id de fila: la clave de una venta importada es
 * fecha|hora|monto_centavos|n-esima ocurrencia igual (sin contar las del POS).
 *
 * No depende de sheets.habilitado (esa es la copia de ventas del POS hacia la
 * planilla): alcanza con sheets.url y sheets.token. Se apaga con
 * config.json -> sheets.importar = false o con POS_SIN_SHEETS=1 (pruebas).
 * Intervalo: sheets.importarSegundos (600 por defecto, minimo 30).
 */

const db = require('./db');

const TIMEOUT_MS = 90000; // la planilla entera: miles de filas

/** Normaliza lo que manda Apps Script: montos a centavos, hora HH:MM o ''. */
function normalizar(movimientos) {
  return (movimientos || []).map((m) => ({
    fecha: String(m.fecha || '').slice(0, 10),
    hora: /^\d{2}:\d{2}/.test(String(m.hora || '')) ? String(m.hora).slice(0, 5) : '',
    tipo: String(m.tipo || '').trim(),
    monto_centavos: Math.round((Number(m.monto) || 0) * 100),
    pagado: m.pagado === true || String(m.pagado).toUpperCase() === 'TRUE',
  })).filter((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.fecha));
}

module.exports = function crearSheetsImportar(config) {
  const cfg = () => config.sheets || {};
  const habilitado = () => process.env.POS_SIN_SHEETS !== '1' &&
    cfg().importar !== false && !!(cfg().url && cfg().token);

  let enCurso = null;
  let pedidoMientras = false;
  let ultimoIntento = null;
  let ultimoResultado = null;
  let timer = null;

  async function pedir() {
    const r = await fetch(cfg().url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accion: 'planilla', token: cfg().token }),
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
    // Una version vieja de "POS -> Planilla" no conoce la accion 'planilla'.
    if (!Array.isArray(d.movimientos)) {
      const e = new Error('Falta publicar la versión nueva del proyecto "POS → Planilla" en Apps Script ' +
        '(Implementar → Administrar implementaciones → editar → Nueva versión)');
      e.codigo = 'version-vieja';
      throw e;
    }
    // Resguardo: si no encontro ninguna hoja de meses (renombradas, planilla
    // equivocada) no se vacia la copia local.
    if (!d.hojas) throw new Error('La planilla no tiene hojas de meses (yyyy o yyyy-MM); no se tocó la copia local');
    return d;
  }

  async function correr() {
    ultimoIntento = new Date().toISOString();
    try {
      const d = await pedir();
      const movimientos = normalizar(d.movimientos);
      const r = db.sincronizarPlanilla({ movimientos, proveedores: d.proveedores || [], leidoEn: ultimoIntento });
      ultimoResultado = { ok: true, movimientos: movimientos.length, ventas_nuevas: r.nuevas, ventas_borradas: r.borradas };
      if (r.nuevas || r.borradas) {
        console.log(`  [sheets] planilla copiada: ${movimientos.length} filas; ventas del bot +${r.nuevas} / -${r.borradas}`);
      }
    } catch (e) {
      const msg = e.name === 'TimeoutError' ? 'Sin respuesta de Google (timeout)'
        : (e.cause && e.cause.code ? `Sin conexión con Google (${e.cause.code})` : e.message);
      ultimoResultado = { ok: false, error: msg, codigo: e.codigo || null };
      console.warn(`  [sheets] no se pudo copiar la planilla: ${msg}`);
    }
  }

  // Si ya hay una lectura en curso, espera esa y hace una mas al terminar
  // (para que "Actualizar ahora" siempre traiga algo posterior al clic).
  async function procesar() {
    if (!habilitado()) return;
    if (enCurso) { pedidoMientras = true; return enCurso; }
    enCurso = (async () => {
      try {
        do { pedidoMientras = false; await correr(); } while (pedidoMientras);
      } finally { enCurso = null; }
    })();
    return enCurso;
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
    const p = db.planillaResumen();
    const im = db.sheetsImportadasResumen();
    return {
      habilitado: habilitado(),
      en_curso: !!enCurso,
      movimientos: p.movimientos,
      gastos: p.gastos,
      proveedores: p.proveedores,
      desde: p.desde,
      hasta: p.hasta,
      leida: p.leida,
      importadas: im.importadas, // ventas del bot en la base (origen 'sheet')
      ultima: im.ultima,
      ultimo_intento: ultimoIntento,
      ultimo_resultado: ultimoResultado,
    };
  }

  return { habilitado, procesar, iniciar, detener, estado };
};

module.exports.normalizar = normalizar;
