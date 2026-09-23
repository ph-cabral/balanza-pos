// ========================================
// VENTAS DEL PUNTO DE VENTA (POS NODE)
// ----------------------------------------
// Etapa de transición: el POS con balanza (servidor Node en la PC
// de la fiambrería) manda cada venta cerrada a este mismo webapp,
// y acá se registra como una fila "cliente", igual que si se
// hubiera mandado el monto por Telegram. Así el bot, los totales
// del día/mes y el dashboard siguen funcionando sin cambios.
//
// El POS manda un POST JSON:
//   { origen: "pos", token: "...", ventas: [
//       { id: 123, clave: "123|2026-09-22 10:41:07", fecha: "2026-09-22",
//         hora: "10:41", monto: 2561.5 }, ... ] }
//
// Responde JSON: { ok: true, aceptadas: [123, ...], rechazadas: [{id, error}] }
//
// Reintentos: si el POS no recibió la respuesta vuelve a mandar la
// misma venta. Para no duplicar filas se guardan las últimas ventas
// registradas en las propiedades del script (POS_IDS_GUARDADOS),
// usando la clave id|fecha que manda el POS.
// ========================================

const POS_IDS_PROP = 'POS_IDS_GUARDADOS';
const POS_IDS_MAX = 250; // ~7 KB: cada propiedad del script admite hasta 9 KB

function recibirVentasPos_(data) {
  if (!CONFIG.POS_TOKEN || data.token !== CONFIG.POS_TOKEN) {
    return responderJson_({ ok: false, error: 'token invalido' });
  }

  const ventas = Array.isArray(data.ventas) ? data.ventas : [];
  if (!ventas.length) return responderJson_({ ok: true, aceptadas: [], rechazadas: [] });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) {
    return responderJson_({ ok: false, error: 'hoja ocupada, reintentar' });
  }

  try {
    const props = PropertiesService.getScriptProperties();
    let ids = [];
    try { ids = JSON.parse(props.getProperty(POS_IDS_PROP) || '[]'); } catch (e) { ids = []; }
    const yaGuardados = {};
    ids.forEach(function (id) { yaGuardados[id] = true; });

    const aceptadas = [];
    const rechazadas = [];
    const porHoja = {}; // nombre de hoja -> { sheet, filas }

    ventas.forEach(function (v) {
      if (!v || !v.id) { rechazadas.push({ id: null, error: 'venta sin id' }); return; }
      const id = String(v.clave || v.id);
      if (yaGuardados[id]) { aceptadas.push(v.id); return; } // reintento: ya estaba

      const fecha = String(v.fecha || '');
      const hora = String(v.hora || '');
      const monto = Number(v.monto);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) { rechazadas.push({ id: v.id, error: 'fecha invalida' }); return; }
      if (!/^\d{2}:\d{2}$/.test(hora)) { rechazadas.push({ id: v.id, error: 'hora invalida' }); return; }
      if (!isFinite(monto) || monto <= 0) { rechazadas.push({ id: v.id, error: 'monto invalido' }); return; }

      const sheet = hojaParaFechaPos_(fecha);
      const nombre = sheet.getName();
      if (!porHoja[nombre]) porHoja[nombre] = { sheet: sheet, filas: [] };
      porHoja[nombre].filas.push([fecha, hora, 'cliente', monto, true]);

      yaGuardados[id] = true;
      ids.push(id);
      aceptadas.push(v.id);
    });

    // Una sola escritura por hoja (más rápido que appendRow fila por fila).
    Object.keys(porHoja).forEach(function (nombre) {
      const h = porHoja[nombre];
      h.sheet.getRange(h.sheet.getLastRow() + 1, 1, h.filas.length, 5).setValues(h.filas);
    });

    if (ids.length > POS_IDS_MAX) ids = ids.slice(ids.length - POS_IDS_MAX);
    props.setProperty(POS_IDS_PROP, JSON.stringify(ids));

    invalidarCacheTotales_();
    return responderJson_({ ok: true, aceptadas: aceptadas, rechazadas: rechazadas });
  } finally {
    lock.releaseLock();
  }
}

// ----------------------------------------
// Hoja donde va una venta según su fecha:
//  - mes en curso  -> hoja mensual 'yyyy-MM' (la "en caliente")
//  - mes anterior que todavía no se archivó -> esa hoja mensual
//  - si no          -> hoja anual 'yyyy' (reintentos atrasados)
// ----------------------------------------
function hojaParaFechaPos_(fecha) {
  const mes = fecha.substring(0, 7);
  if (mes === getSheetName()) return getOrCreateSheet();

  const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const hojaMes = spreadsheet.getSheetByName(mes);
  if (hojaMes) return hojaMes;

  const año = fecha.substring(0, 4);
  return spreadsheet.getSheetByName(año) || crearHojaAnualVacia_(spreadsheet, año);
}

function responderJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ----------------------------------------
// Prueba manual desde el editor: registra una venta de $1 con un
// id de prueba. Borrar la fila a mano después.
// ----------------------------------------
function probarVentaPos() {
  const ahora = new Date();
  const r = recibirVentasPos_({
    origen: 'pos',
    token: CONFIG.POS_TOKEN,
    ventas: [{
      id: 'prueba-' + ahora.getTime(),
      fecha: Utilities.formatDate(ahora, CONFIG.TIMEZONE, 'yyyy-MM-dd'),
      hora: Utilities.formatDate(ahora, CONFIG.TIMEZONE, 'HH:mm'),
      monto: 1,
    }],
  });
  Logger.log(r.getContent());
}
