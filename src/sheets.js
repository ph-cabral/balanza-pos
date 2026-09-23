'use strict';

/**
 * Copia de las ventas a Google Sheets (etapa de transicion).
 *
 * Mientras conviven el POS nuevo y la planilla vieja, cada venta cerrada se
 * manda al webapp de Apps Script (ver pos.gs), que la registra como una fila
 * "cliente" en la hoja del mes: Fecha | Hora | cliente | Monto | TRUE.
 *
 * - La venta se guarda SIEMPRE primero en SQLite; Sheets nunca frena la caja.
 * - Cada venta entra a la tabla sheets_cola en la misma transaccion.
 * - Se envian en lotes; lo que falla (sin internet, Google caido) queda
 *   pendiente y se reintenta solo cada `reintentoSegundos`.
 * - El webapp descarta ids repetidos, asi que reintentar no duplica filas.
 *
 * Para apagarlo: config.json -> sheets.habilitado = false (y reiniciar el POS).
 */

const db = require('./db');

const LOTE = 50;
const TIMEOUT_MS = 30000;

module.exports = function crearSheets(config) {
  const cfg = () => config.sheets || {};
  // POS_SIN_SHEETS=1 lo apaga sin tocar config.json (lo usan los scripts de prueba).
  const habilitado = () => process.env.POS_SIN_SHEETS !== '1' &&
    !!(cfg().habilitado && cfg().url && cfg().token);

  let enCurso = false;
  let pedidoMientras = false;
  let ultimoIntento = null;
  let ultimoResultado = null;
  let timer = null;

  function aPayload(v) {
    // v.fecha viene de SQLite en hora local: 'YYYY-MM-DD HH:MM:SS'
    return {
      id: v.id,
      // Clave de deduplicacion en la planilla: id + fecha y hora de la venta.
      // Si algun dia se recrea pos.db y los ids vuelven a 1, no chocan con los viejos.
      clave: `${v.id}|${v.fecha}`,
      fecha: v.fecha.slice(0, 10),
      hora: v.fecha.slice(11, 16),
      monto: v.total_centavos / 100,
    };
  }

  async function enviarLote(filas) {
    const cuerpo = JSON.stringify({ origen: 'pos', token: cfg().token, ventas: filas.map(aPayload) });
    const r = await fetch(cfg().url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: cuerpo,
      redirect: 'follow', // Apps Script responde con un 302 a googleusercontent
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const texto = await r.text();
    let d;
    try { d = JSON.parse(texto); } catch (_) {
      if (r.status === 404) {
        throw new Error('La URL del webapp no existe (HTTP 404): la implementación fue borrada o archivada. ' +
          'Copiar la URL /exec vigente de Apps Script (Implementar → Administrar implementaciones) en config.json → sheets.url');
      }
      if (/accounts\.google\.com|ServiceLogin/.test(r.url + texto.slice(0, 2000))) {
        throw new Error('El webapp pide iniciar sesión: en la implementación, "Quién tiene acceso" tiene que ser "Cualquier usuario"');
      }
      throw new Error(`Respuesta no JSON (HTTP ${r.status}). ¿Se publicó una versión nueva del webapp con pos.gs?`);
    }
    if (!d.ok) throw new Error(d.error || 'La planilla rechazó el envío');
    return d;
  }

  async function procesar() {
    if (!habilitado()) return;
    if (enCurso) { pedidoMientras = true; return; }
    enCurso = true;
    try {
      // Vacia la cola en lotes; corta en el primer error y espera al proximo ciclo.
      for (;;) {
        const filas = db.sheetsPendientes(LOTE);
        if (!filas.length) break;
        ultimoIntento = new Date().toISOString();
        let d;
        try {
          d = await enviarLote(filas);
        } catch (e) {
          const msg = e.name === 'TimeoutError' ? 'Sin respuesta de Google (timeout)' : e.message;
          db.sheetsMarcarError(filas.map((f) => f.id), msg);
          ultimoResultado = { ok: false, error: msg };
          console.warn(`  [sheets] ${filas.length} venta(s) pendientes: ${msg}`);
          break;
        }
        const aceptadas = new Set((d.aceptadas || []).map(Number));
        const ok = filas.filter((f) => aceptadas.has(Number(f.id))).map((f) => f.id);
        const malas = filas.filter((f) => !aceptadas.has(Number(f.id)));
        if (ok.length) db.sheetsMarcarOk(ok);
        for (const m of malas) {
          const rech = (d.rechazadas || []).find((x) => Number(x.id) === Number(m.id));
          db.sheetsMarcarError([m.id], rech ? rech.error : 'no aceptada');
        }
        ultimoResultado = { ok: malas.length === 0, enviadas: ok.length, rechazadas: malas.length };
        if (malas.length) break; // no insistir en bucle con una venta rechazada
      }
    } finally {
      enCurso = false;
      if (pedidoMientras) { pedidoMientras = false; setImmediate(procesar); }
    }
  }

  function iniciar() {
    if (timer) clearInterval(timer);
    const seg = Math.max(10, Number(cfg().reintentoSegundos) || 60);
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
      ...db.sheetsResumen(),
      ultimo_intento: ultimoIntento,
      ultimo_resultado: ultimoResultado,
    };
  }

  return {
    habilitado,
    // Se llama despues de guardar una venta: intenta mandarla ya, sin esperar.
    avisarVentaNueva: () => { procesar().catch(() => {}); },
    procesar,
    iniciar,
    detener,
    estado,
  };
};
