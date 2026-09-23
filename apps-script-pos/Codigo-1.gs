// ========================================
// POS → PLANILLA (proyecto de Apps Script aparte)
// ----------------------------------------
// Recibe las ventas del POS con balanza (servidor Node) y:
//  1. las registra como filas "cliente" en la MISMA planilla que usa el
//     bot de Telegram: Fecha | Hora | cliente | Monto | TRUE;
//  2. avisa por Telegram con el mismo mensaje que da hoy el bot
//     ("Monto ingresado / Ingreso día / Ingreso mes"), usando el mismo bot.
//
// Es un proyecto independiente del bot: se publica con su propia URL
// /exec y no hace falta tocar ni volver a implementar el bot.
//
// CLAVES (no van en el código): Configuración del proyecto (engranaje)
// → Propiedades del script:
//   POS_TOKEN         igual a config.json -> sheets.token del POS (obligatoria)
//   TELEGRAM_TOKEN    el token del bot (el mismo de config.gs del bot)
//   TELEGRAM_CHAT_ID  chat/s donde avisar; varios separados por coma
// Sin TELEGRAM_TOKEN o TELEGRAM_CHAT_ID las ventas se registran igual,
// solo que sin aviso.
//
// El POS manda un POST JSON:
//   { origen: "pos", token: "...", ventas: [
//       { id: 123, clave: "123|2026-09-22 10:41:07", fecha: "2026-09-22",
//         hora: "10:41", monto: 2561.5 }, ... ] }
// Responde JSON: { ok: true, aceptadas: [123, ...], rechazadas: [{id, error}] }
//
// Convivencia con el bot (son dos proyectos, no comparten lock ni cache):
//  - Se escribe con appendRow, que es atómico: aunque el bot escriba en
//    el mismo instante, ninguna fila pisa a otra.
//  - El total día/mes del bot tiene un cache de hasta ~20 s; una venta
//    del POS puede tardar ese tiempo en verse en el total del bot.
//  - Cambio de mes: si la hoja del mes en curso no existe, se archiva el
//    mes anterior en la hoja anual y se crea la nueva, igual que el bot.
//  - El aviso de Telegram va SIN los botones Proveedor / Gasto / Eliminar:
//    esos botones los atiende el bot y cambiarían la planilla sin que se
//    entere el POS (la venta seguiría en el POS). Las anulaciones se hacen
//    en el POS.
// ========================================

const POS_CONFIG = {
  SHEET_ID: '15eZpBLQVGjY54vA_07kauFhhu2a7ocEXF6jQ-d-hHf4',
  TIMEZONE: 'America/Argentina/Buenos_Aires',
  TELEGRAM_API_BASE: 'https://api.telegram.org',
  // Si llegan más ventas nuevas juntas que esto (el POS estuvo sin
  // internet y manda las pendientes), se manda un solo mensaje resumen.
  AVISOS_INDIVIDUALES_MAX: 5,
};

function propPos_(nombre) {
  return String(PropertiesService.getScriptProperties().getProperty(nombre) || '').trim();
}

const POS_IDS_PROP = 'POS_IDS_GUARDADOS';
const POS_IDS_MAX = 250; // ~7 KB: cada propiedad del script admite hasta 9 KB
const POS_ENCABEZADOS = ['Fecha', 'Hora', 'Proveedor', 'Monto', 'Pagado'];

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return responderJson_({ ok: false, error: 'cuerpo no es JSON' });
  }
  try {
    return recibirVentasPos_(data);
  } catch (err) {
    return responderJson_({ ok: false, error: String(err) });
  }
}

// Para probar la URL desde el navegador: debe mostrar {"ok":true,...}
function doGet() {
  return responderJson_({ ok: true, servicio: 'pos-planilla' });
}

function recibirVentasPos_(data) {
  const tokenEsperado = propPos_('POS_TOKEN');
  if (!tokenEsperado || !data || data.token !== tokenEsperado) {
    return responderJson_({ ok: false, error: 'token invalido' });
  }

  const ventas = Array.isArray(data.ventas) ? data.ventas : [];
  if (!ventas.length) return responderJson_({ ok: true, aceptadas: [], rechazadas: [] });

  // Lock propio: evita que dos envíos del POS se pisen entre sí.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) {
    return responderJson_({ ok: false, error: 'hoja ocupada, reintentar' });
  }
  let locked = true;

  try {
    const props = PropertiesService.getScriptProperties();
    let ids = [];
    try { ids = JSON.parse(props.getProperty(POS_IDS_PROP) || '[]'); } catch (err) { ids = []; }
    const yaGuardados = {};
    ids.forEach(function (id) { yaGuardados[id] = true; });

    const spreadsheet = SpreadsheetApp.openById(POS_CONFIG.SHEET_ID);
    const aceptadas = [];
    const rechazadas = [];
    const nuevas = []; // escritas en esta llamada (no reintentos): se avisan por Telegram

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

      const sheet = hojaParaFechaPos_(spreadsheet, fecha);
      sheet.appendRow([fecha, hora, 'cliente', monto, true]);

      // Se marca como guardada después de cada fila: si algo falla a
      // mitad de un lote, lo ya escrito no se vuelve a escribir.
      yaGuardados[id] = true;
      ids.push(id);
      if (ids.length > POS_IDS_MAX) ids = ids.slice(ids.length - POS_IDS_MAX);
      props.setProperty(POS_IDS_PROP, JSON.stringify(ids));
      aceptadas.push(v.id);
      nuevas.push({ fecha: fecha, hora: hora, monto: monto });
    });

    lock.releaseLock();
    locked = false;

    // El aviso va después de escribir y fuera del lock: si Telegram falla,
    // la venta ya quedó registrada y el POS la da por copiada igual.
    const aviso = avisarTelegramPos_(spreadsheet, nuevas);
    return responderJson_({ ok: true, aceptadas: aceptadas, rechazadas: rechazadas, telegram: aviso });
  } finally {
    if (locked) lock.releaseLock();
  }
}

// ----------------------------------------
// Hoja donde va una venta según su fecha:
//  - mes en curso  -> hoja mensual 'yyyy-MM' (se crea si hace falta)
//  - mes anterior que todavía no se archivó -> esa hoja mensual
//  - si no          -> hoja anual 'yyyy' (reintentos atrasados)
// ----------------------------------------
function hojaParaFechaPos_(spreadsheet, fecha) {
  const mes = fecha.substring(0, 7);
  const mesActual = Utilities.formatDate(new Date(), POS_CONFIG.TIMEZONE, 'yyyy-MM');
  if (mes === mesActual) return hojaMesActualPos_(spreadsheet, mesActual);

  const hojaMes = spreadsheet.getSheetByName(mes);
  if (hojaMes) return hojaMes;

  const anio = fecha.substring(0, 4);
  return spreadsheet.getSheetByName(anio) || crearHojaPos_(spreadsheet, anio);
}

// Igual que getOrCreateSheet() del bot: si arrancó un mes nuevo,
// primero archiva el mes anterior en la hoja anual y después crea la hoja.
function hojaMesActualPos_(spreadsheet, mesActual) {
  let sheet = spreadsheet.getSheetByName(mesActual);
  if (sheet) return sheet;

  archivarMesAnteriorPos_(spreadsheet, mesActual);

  // Pudo crearla el bot mientras tanto.
  sheet = spreadsheet.getSheetByName(mesActual);
  if (sheet) return sheet;

  sheet = crearHojaPos_(spreadsheet, mesActual);
  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidth(2, 80);
  sheet.setColumnWidth(3, 200);
  sheet.setColumnWidth(4, 100);
  sheet.setColumnWidth(5, 80);
  return sheet;
}

function archivarMesAnteriorPos_(spreadsheet, mesActual) {
  const partes = mesActual.split('-');
  const d = new Date(Number(partes[0]), Number(partes[1]) - 1, 1);
  d.setMonth(d.getMonth() - 1);
  const mesAnterior = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');

  const hojaAnterior = spreadsheet.getSheetByName(mesAnterior);
  if (!hojaAnterior) return; // nada pendiente de archivar

  const anio = mesAnterior.substring(0, 4);
  const archivo = spreadsheet.getSheetByName(anio) || crearHojaPos_(spreadsheet, anio);

  const datos = hojaAnterior.getDataRange().getValues().slice(1).filter(function (f) { return f[0]; });
  if (datos.length > 0) {
    archivo.getRange(archivo.getLastRow() + 1, 1, datos.length, 5).setValues(datos);
  }
  spreadsheet.deleteSheet(hojaAnterior);
}

function crearHojaPos_(spreadsheet, nombre) {
  const sheet = spreadsheet.insertSheet(nombre);
  sheet.getRange(1, 1, 1, POS_ENCABEZADOS.length).setValues([POS_ENCABEZADOS])
    .setFontWeight('bold').setBackground('#4285f4').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  return sheet;
}

// ----------------------------------------
// AVISO POR TELEGRAM
// Mismo texto que formatearRespuesta() del bot. Los totales se calculan
// igual que calcularTotales() del bot, leyendo la hoja del mes en curso.
// ----------------------------------------
function avisarTelegramPos_(spreadsheet, nuevas) {
  if (!nuevas.length) return 'sin ventas nuevas';
  const token = propPos_('TELEGRAM_TOKEN');
  const chats = propPos_('TELEGRAM_CHAT_ID').split(',').map(function (c) { return c.trim(); }).filter(String);
  if (!token || !chats.length) return 'sin configurar';

  try {
    const t = totalesMesPos_(spreadsheet);
    const hoy = Utilities.formatDate(new Date(), POS_CONFIG.TIMEZONE, 'yyyy-MM-dd');
    const mensajes = [];

    if (nuevas.length > POS_CONFIG.AVISOS_INDIVIDUALES_MAX) {
      const suma = nuevas.reduce(function (acc, v) { return acc + v.monto; }, 0);
      mensajes.push(`✅ ${nuevas.length} ventas del POS que estaban pendientes: $${montoPos_(suma)}` + pieTotalesPos_(t));
    } else {
      nuevas.forEach(function (v) {
        // Si llega atrasada (el POS estuvo sin internet) se aclara cuándo fue.
        const cuando = v.fecha === hoy ? '' : ` (venta del ${v.fecha.substring(8, 10)}/${v.fecha.substring(5, 7)} ${v.hora})`;
        mensajes.push(`✅ Monto ingresado: $${montoPos_(v.monto)} · POS${cuando}` + pieTotalesPos_(t));
      });
    }

    const errores = [];
    mensajes.forEach(function (texto) {
      chats.forEach(function (chatId) {
        const r = UrlFetchApp.fetch(`${POS_CONFIG.TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
          method: 'post',
          contentType: 'application/json',
          payload: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML' }),
          muteHttpExceptions: true,
        });
        if (r.getResponseCode() !== 200) errores.push(chatId + ': HTTP ' + r.getResponseCode() + ' ' + r.getContentText().substring(0, 200));
      });
    });
    if (errores.length) {
      Logger.log('Telegram: ' + errores.join(' | '));
      return 'error: ' + errores.join(' | ');
    }
    return 'ok';
  } catch (err) {
    Logger.log('Telegram: ' + err);
    return 'error: ' + err;
  }
}

function pieTotalesPos_(t) {
  let texto = `

💰 Ingreso día: $${formatearNumeroPos_(t.totalDia)}
📅 Ingreso mes: $${formatearNumeroPos_(t.totalMes)}
`;
  if (t.totalMercaderia > 0 || t.totalDesperdicio > 0) {
    texto += `\n\n📦 Mercadería: $${formatearNumeroPos_(t.totalMercaderia)}`;
    texto += `\n🗑️ Desperdicio: $${formatearNumeroPos_(t.totalDesperdicio)}`;
  }
  return texto;
}

// Igual que calcularTotales() del bot (sin su cache de 20 s).
function totalesMesPos_(spreadsheet) {
  const ahora = new Date();
  const hoy = Utilities.formatDate(ahora, POS_CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const mesActual = Utilities.formatDate(ahora, POS_CONFIG.TIMEZONE, 'yyyy-MM');
  const t = { totalDia: 0, totalMes: 0, totalMercaderia: 0, totalDesperdicio: 0 };

  const sheet = spreadsheet.getSheetByName(mesActual);
  if (!sheet) return t;
  const datos = sheet.getDataRange().getValues();

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const fechaFila = fila[0] instanceof Date
      ? Utilities.formatDate(fila[0], POS_CONFIG.TIMEZONE, 'yyyy-MM-dd')
      : String(fila[0]).trim().substring(0, 10);
    const tipo = fila[2];
    const monto = parseFloat(fila[3]) || 0;

    if (fechaFila === hoy && tipo === 'cliente') t.totalDia += monto;
    if (fechaFila.startsWith(mesActual) && fila[4] === true) {
      t.totalMes += monto; // los egresos ya son negativos
      if (tipo === 'mercaderia') t.totalMercaderia += Math.abs(monto);
      else if (tipo === 'desperdicio') t.totalDesperdicio += Math.abs(monto);
    }
  }
  return t;
}

// Igual que formatearNumero() del bot: redondeado, con punto de miles.
function formatearNumeroPos_(num) {
  return Math.round(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// El monto de la venta muestra los centavos si los tiene: 2561.5 → 2.561,50
function montoPos_(num) {
  const centavos = Math.round(num * 100) % 100;
  return formatearNumeroPos_(Math.floor(Math.round(num * 100) / 100)) +
    (centavos ? ',' + String(centavos).padStart(2, '0') : '');
}

function responderJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ----------------------------------------
// Prueba manual desde el editor (también sirve para dar los permisos
// la primera vez): registra una venta de $1 y manda el aviso por
// Telegram. Borrar la fila después.
// ----------------------------------------
function probarVentaPos() {
  const ahora = new Date();
  const r = recibirVentasPos_({
    origen: 'pos',
    token: propPos_('POS_TOKEN'),
    ventas: [{
      id: 'prueba-' + ahora.getTime(),
      fecha: Utilities.formatDate(ahora, POS_CONFIG.TIMEZONE, 'yyyy-MM-dd'),
      hora: Utilities.formatDate(ahora, POS_CONFIG.TIMEZONE, 'HH:mm'),
      monto: 1,
    }],
  });
  Logger.log(r.getContent());
}

// ----------------------------------------
// Prueba solo del aviso, sin tocar la planilla.
// ----------------------------------------
function probarTelegramPos() {
  const token = propPos_('TELEGRAM_TOKEN');
  const chats = propPos_('TELEGRAM_CHAT_ID').split(',').map(function (c) { return c.trim(); }).filter(String);
  if (!token || !chats.length) {
    Logger.log('Faltan las propiedades TELEGRAM_TOKEN y/o TELEGRAM_CHAT_ID');
    return;
  }
  chats.forEach(function (chatId) {
    const r = UrlFetchApp.fetch(`${POS_CONFIG.TELEGRAM_API_BASE}/bot${token}/sendMessage`, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ chat_id: chatId, text: '🧪 Prueba del aviso de ventas del POS' }),
      muteHttpExceptions: true,
    });
    Logger.log(chatId + ' → HTTP ' + r.getResponseCode() + ' ' + r.getContentText());
  });
}
