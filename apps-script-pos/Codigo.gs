// ========================================
// POS → PLANILLA (proyecto de Apps Script aparte)
// ----------------------------------------
// Recibe las ventas del POS con balanza (servidor Node), las registra
// como filas "cliente" en la MISMA planilla que usa el bot de Telegram
// (Fecha | Hora | cliente | Monto | TRUE) y avisa cada venta al grupo
// de Telegram con el mismo mensaje que da el bot.
//
// Proyecto independiente del bot: tiene su propia URL /exec.
//
// CLAVES: no van en el código. Se cargan en
//   Configuración del proyecto (engranaje) → Propiedades de script:
//     POS_TOKEN         (obligatoria) = config.json → sheets.token del POS
//     TELEGRAM_TOKEN    token del bot (el mismo de config.gs del bot)
//     TELEGRAM_CHAT_ID  chat/grupo donde avisar; varios separados por coma
//   Sin TELEGRAM_* las ventas se registran igual, sin aviso.
//   La propiedad POS_IDS_GUARDADOS la crea y mantiene el script solo.
//
// El POS manda un POST JSON:
//   { origen: "pos", token: "...", ventas: [
//       { id: 123, clave: "123|2026-09-22 10:41:07", fecha: "2026-09-22",
//         hora: "10:41", monto: 2561.5 }, ... ] }
// Responde JSON:
//   { ok: true, aceptadas: [123, ...], rechazadas: [{id, error}],
//     telegram: "ok" | "sin configurar" | "sin ventas nuevas" | "error: ..." }
//
// También responde, solo lectura, la planilla entera para que el POS
// tenga la misma información en su base SQLite:
//   { accion: "planilla", token: "..." }  (ver leerPlanillaPos_)
// y, por compatibilidad con versiones anteriores del POS, "gastos" (un mes)
// y "ventas" (solo filas cliente).
//
// Convivencia con el bot (dos proyectos, no comparten lock ni cache):
//  - Se escribe con appendRow, que es atómico: aunque el bot escriba en
//    el mismo instante, ninguna fila pisa a otra.
//  - El total día/mes del bot tiene cache de hasta ~20 s; una venta del
//    POS puede tardar ese tiempo en verse en el total del bot.
//  - Cambio de mes: si la hoja del mes en curso no existe, se archiva el
//    mes anterior en la hoja anual y se crea la nueva, igual que el bot.
// ========================================

const POS_CONFIG = {
  SHEET_ID: '15eZpBLQVGjY54vA_07kauFhhu2a7ocEXF6jQ-d-hHf4',
  TIMEZONE: 'America/Argentina/Buenos_Aires',
  TELEGRAM_API_BASE: 'https://api.telegram.org',
  MAX_AVISOS_INDIVIDUALES: 5, // más ventas nuevas juntas → un solo resumen
};

const POS_IDS_PROP = 'POS_IDS_GUARDADOS';
const POS_IDS_MAX = 250; // ~7 KB: cada propiedad del script admite hasta 9 KB
const POS_ENCABEZADOS = ['Fecha', 'Hora', 'Proveedor', 'Monto', 'Pagado'];

// Tipos que el bot separa en el cálculo de totales (mismos valores que TIPOS_PAGO)
const POS_TIPO_GASTO = 'gasto_personal';
const POS_TIPO_MERCADERIA = 'mercaderia';
const POS_TIPO_DESPERDICIO = 'desperdicio';

// ========================================
// ENTRADAS WEB
// ========================================
function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return responderJson_({ ok: false, error: 'cuerpo no es JSON' });
  }
  try {
    // Consulta de gastos (solo lectura) para Administración → Ventas del POS.
    if (data && data.accion === 'gastos') {
      return responderJson_(leerGastosPos_(data, leerConfigPos_()));
    }
    // Planilla entera (solo lectura): el POS la copia a su base SQLite.
    if (data && data.accion === 'planilla') {
      return responderJson_(leerPlanillaPos_(data, leerConfigPos_()));
    }
    // Consulta de ventas (solo lectura) de versiones anteriores del POS.
    if (data && data.accion === 'ventas') {
      return responderJson_(leerVentasPos_(data, leerConfigPos_()));
    }
    const r = procesarYAvisar_(data);
    return responderJson_(r);
  } catch (err) {
    return responderJson_({ ok: false, error: String(err) });
  }
}

// Para probar la URL desde el navegador: debe mostrar {"ok":true,...}
function doGet() {
  return responderJson_({ ok: true, servicio: 'pos-planilla' });
}

// ========================================
// CONFIGURACIÓN DESDE PROPIEDADES DEL SCRIPT
// ========================================
function leerConfigPos_() {
  const props = PropertiesService.getScriptProperties();
  const limpiar = function (v) { return String(v || '').trim(); };
  return {
    posToken: limpiar(props.getProperty('POS_TOKEN')),
    telegramToken: limpiar(props.getProperty('TELEGRAM_TOKEN')),
    chatIds: limpiar(props.getProperty('TELEGRAM_CHAT_ID'))
      .split(',')
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; }),
  };
}

// ========================================
// REGISTRAR + AVISAR
// ----------------------------------------
// La escritura va dentro del lock; el aviso por Telegram va DESPUÉS y
// fuera del lock. Si Telegram falla, la venta queda registrada igual y
// el POS la da por copiada (no se reintenta ni se duplica).
// ========================================
function procesarYAvisar_(data) {
  const cfg = leerConfigPos_();
  const r = recibirVentasPos_(data, cfg);
  if (!r.ok) return r;

  const nuevas = r.nuevas;
  delete r.nuevas;

  if (!nuevas.length) {
    r.telegram = 'sin ventas nuevas';
  } else if (!cfg.telegramToken || !cfg.chatIds.length) {
    r.telegram = 'sin configurar';
  } else {
    try {
      avisarVentasTelegram_(cfg, nuevas);
      r.telegram = 'ok';
    } catch (err) {
      r.telegram = 'error: ' + String(err && err.message ? err.message : err);
    }
  }
  return r;
}

// ========================================
// REGISTRAR VENTAS EN LA PLANILLA
// Devuelve { ok, aceptadas, rechazadas, nuevas } — "nuevas" son las que
// se escribieron en esta llamada (no los reintentos ya guardados).
// ========================================
function recibirVentasPos_(data, cfg) {
  if (!cfg.posToken || !data || data.token !== cfg.posToken) {
    return { ok: false, error: 'token invalido' };
  }

  const ventas = Array.isArray(data.ventas) ? data.ventas : [];
  if (!ventas.length) return { ok: true, aceptadas: [], rechazadas: [], nuevas: [] };

  // Lock propio: evita que dos envíos del POS se pisen entre sí.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) {
    return { ok: false, error: 'hoja ocupada, reintentar' };
  }

  try {
    const props = PropertiesService.getScriptProperties();
    let ids = [];
    try { ids = JSON.parse(props.getProperty(POS_IDS_PROP) || '[]'); } catch (err) { ids = []; }
    const yaGuardados = {};
    ids.forEach(function (id) { yaGuardados[id] = true; });

    const spreadsheet = SpreadsheetApp.openById(POS_CONFIG.SHEET_ID);
    const aceptadas = [];
    const rechazadas = [];
    const nuevas = [];

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

    return { ok: true, aceptadas: aceptadas, rechazadas: rechazadas, nuevas: nuevas };
  } finally {
    lock.releaseLock();
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

// ========================================
// TOTALES — misma lógica que calcularTotales() del bot, sin cache
// (el POS no puede invalidar el cache del bot, así que lee directo
// la hoja del mes en curso).
// ========================================
function calcularTotalesPos_() {
  const ahora = new Date();
  const hoy = Utilities.formatDate(ahora, POS_CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const mesActual = Utilities.formatDate(ahora, POS_CONFIG.TIMEZONE, 'yyyy-MM');

  const res = { totalDia: 0, totalMes: 0, totalMercaderia: 0, totalDesperdicio: 0, hoy: hoy, mesActual: mesActual };

  const sheet = SpreadsheetApp.openById(POS_CONFIG.SHEET_ID).getSheetByName(mesActual);
  if (!sheet) return res;

  const datos = sheet.getDataRange().getValues();
  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    if (!fila[0]) continue;
    const fechaFila = normalizarFechaPos_(fila[0]);
    const tipo = fila[2];
    const montoFila = parseFloat(fila[3]) || 0;
    const pagado = fila[4];

    if (fechaFila === hoy && tipo === 'cliente') res.totalDia += montoFila;

    if (fechaFila.indexOf(mesActual) === 0 && pagado === true) {
      res.totalMes += montoFila; // los egresos ya son negativos
      if (tipo === POS_TIPO_MERCADERIA) res.totalMercaderia += Math.abs(montoFila);
      else if (tipo === POS_TIPO_DESPERDICIO) res.totalDesperdicio += Math.abs(montoFila);
    }
  }
  return res;
}

// ========================================
// GASTOS DE UN MES (solo lectura)
// ----------------------------------------
// El POS los muestra en Administración → Ventas, separados por proveedor.
// Pedido:    { accion: "gastos", token: "...", mes: "yyyy-MM" }
// Respuesta: { ok, mes, gastos: [{ fecha, hora, detalle, monto, pagado }],
//              proveedores: ["Coca", ...] }
// Un gasto es toda fila que no es "cliente" (proveedor pagado o a pagar,
// gasto personal o mercadería —el bot guarda el usuario—, desperdicio).
// "monto" va en positivo, tal como está en la planilla sin el signo.
// Lee la hoja del mes y la anual (meses ya archivados), como
// getFilasDelAño() del dashboard. No escribe nada.
// ========================================
function leerGastosPos_(data, cfg) {
  if (!cfg.posToken || !data || data.token !== cfg.posToken) {
    return { ok: false, error: 'token invalido' };
  }
  const mes = String(data.mes || '');
  if (!/^\d{4}-\d{2}$/.test(mes)) return { ok: false, error: 'mes invalido' };

  const spreadsheet = SpreadsheetApp.openById(POS_CONFIG.SHEET_ID);
  const anio = mes.substring(0, 4);
  const patron = new RegExp('^' + anio + '(-\\d{2})?$');
  const gastos = [];

  spreadsheet.getSheets().forEach(function (sheet) {
    const nombre = sheet.getName();
    if (!patron.test(nombre)) return;
    if (nombre.length === 7 && nombre !== mes) return; // hoja de otro mes
    const datos = sheet.getDataRange().getValues();
    for (let i = 1; i < datos.length; i++) {
      const fila = datos[i];
      if (!fila[0]) continue;
      const tipo = String(fila[2] || '').trim();
      if (!tipo || tipo === 'cliente') continue;
      const fecha = normalizarFechaPos_(fila[0]);
      if (fecha.substring(0, 7) !== mes) continue;
      const monto = Math.abs(parseFloat(fila[3]) || 0);
      if (!monto) continue;
      gastos.push({
        fecha: fecha,
        hora: normalizarHoraPos_(fila[1]),
        detalle: tipo,
        monto: monto,
        pagado: fila[4] === true || String(fila[4]).toUpperCase() === 'TRUE',
      });
    }
  });

  gastos.sort(function (a, b) { return (a.fecha + a.hora) < (b.fecha + b.hora) ? -1 : 1; });

  let proveedores = [];
  const hojaProv = spreadsheet.getSheetByName('proveedores');
  if (hojaProv) {
    proveedores = hojaProv.getDataRange().getValues().slice(1)
      .map(function (f) { return String(f[0] || '').trim(); })
      .filter(function (n) { return n.length > 0; });
  }

  return { ok: true, servicio: 'pos-planilla', mes: mes, gastos: gastos, proveedores: proveedores };
}

// ========================================
// VENTAS DE LA PLANILLA (solo lectura, para importar a SQLite)
// ----------------------------------------
// El POS trae todas las filas "cliente" (ventas que carga el bot de Telegram
// para quienes todavia no usan el POS con balanza) para copiarlas a su base.
// No filtra por mes: sirve tanto para la carga inicial completa como para el
// escaneo periodico (el POS descarta lo que ya tiene, por fecha+hora+monto).
// Pedido:    { accion: "ventas", token: "..." }
// Respuesta: { ok, ventas: [{ fecha, hora, monto }, ...] }
// ========================================
function leerVentasPos_(data, cfg) {
  if (!cfg.posToken || !data || data.token !== cfg.posToken) {
    return { ok: false, error: 'token invalido' };
  }

  const spreadsheet = SpreadsheetApp.openById(POS_CONFIG.SHEET_ID);
  const patron = /^\d{4}(-\d{2})?$/; // hojas anuales 'yyyy' y mensuales 'yyyy-MM'
  const ventas = [];

  spreadsheet.getSheets().forEach(function (sheet) {
    const nombre = sheet.getName();
    if (!patron.test(nombre)) return;
    const datos = sheet.getDataRange().getValues();
    for (let i = 1; i < datos.length; i++) {
      const fila = datos[i];
      if (!fila[0]) continue;
      const tipo = String(fila[2] || '').trim();
      if (tipo !== 'cliente') continue;
      const monto = parseFloat(fila[3]) || 0;
      if (!monto) continue;
      ventas.push({
        fecha: normalizarFechaPos_(fila[0]),
        hora: normalizarHoraPos_(fila[1]),
        monto: monto,
      });
    }
  });

  ventas.sort(function (a, b) { return (a.fecha + a.hora) < (b.fecha + b.hora) ? -1 : 1; });

  return { ok: true, servicio: 'pos-planilla', ventas: ventas };
}

// ========================================
// PLANILLA ENTERA (solo lectura, para copiarla a SQLite)
// ----------------------------------------
// Devuelve TODAS las filas de TODAS las hojas de movimientos (anuales 'yyyy'
// y mensuales 'yyyy-MM'), de cualquier tipo (cliente, proveedores, gasto
// personal, mercadería, desperdicio...), más la lista de proveedores. El POS
// reemplaza con esto su copia completa en cada lectura, así que lo que el bot
// reclasifica o elimina también se refleja allá. La división mes en curso /
// hoja anual es solo de la planilla: en SQLite es una única tabla.
// Pedido:    { accion: "planilla", token: "..." }
// Respuesta: { ok, hojas, movimientos: [{ fecha, hora, tipo, monto, pagado }],
//              proveedores: ["Coca", ...] }
// "monto" va con el signo de la planilla (egresos en negativo). El orden es
// por fecha y hora, y entre filas iguales el de la planilla (estable).
// ========================================
function leerPlanillaPos_(data, cfg) {
  if (!cfg.posToken || !data || data.token !== cfg.posToken) {
    return { ok: false, error: 'token invalido' };
  }

  const spreadsheet = SpreadsheetApp.openById(POS_CONFIG.SHEET_ID);
  const patron = /^\d{4}(-\d{2})?$/;
  const movimientos = [];
  let hojas = 0;

  // Primero las anuales (meses archivados, más viejos) y después las mensuales.
  const lista = spreadsheet.getSheets().filter(function (sh) { return patron.test(sh.getName()); });
  lista.sort(function (a, b) { return a.getName() < b.getName() ? -1 : (a.getName() > b.getName() ? 1 : 0); });

  lista.forEach(function (sheet) {
    hojas++;
    const datos = sheet.getDataRange().getValues();
    for (let i = 1; i < datos.length; i++) {
      const fila = datos[i];
      if (!fila[0]) continue;
      movimientos.push({
        fecha: normalizarFechaPos_(fila[0]),
        hora: normalizarHoraPos_(fila[1]),
        tipo: String(fila[2] || '').trim(),
        monto: parseFloat(fila[3]) || 0,
        pagado: fila[4] === true || String(fila[4]).toUpperCase() === 'TRUE',
      });
    }
  });

  // sort de V8 es estable: filas iguales quedan en el orden de la planilla.
  movimientos.sort(function (a, b) {
    const x = a.fecha + a.hora;
    const y = b.fecha + b.hora;
    return x < y ? -1 : (x > y ? 1 : 0);
  });

  let proveedores = [];
  const hojaProv = spreadsheet.getSheetByName('proveedores');
  if (hojaProv) {
    proveedores = hojaProv.getDataRange().getValues().slice(1)
      .map(function (f) { return String(f[0] || '').trim(); })
      .filter(function (n) { return n.length > 0; });
  }

  return { ok: true, servicio: 'pos-planilla', hojas: hojas, movimientos: movimientos, proveedores: proveedores };
}

// Igual que normalizarHora() del bot: Sheets convierte "21:12" en una hora real.
function normalizarHoraPos_(valorCelda) {
  if (valorCelda instanceof Date) {
    return Utilities.formatDate(valorCelda, POS_CONFIG.TIMEZONE, 'HH:mm');
  }
  return String(valorCelda || '').trim().substring(0, 5);
}

// Igual que normalizarFecha() del bot: nunca re-parsear un texto con new Date().
function normalizarFechaPos_(valorCelda) {
  if (valorCelda instanceof Date) {
    return Utilities.formatDate(valorCelda, POS_CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }
  return String(valorCelda).trim().substring(0, 10);
}

// ========================================
// AVISO POR TELEGRAM
// ----------------------------------------
// Mismo texto que formatearRespuesta() del bot, con "· POS" al final de
// la primera línea y SIN botones (Proveedor/Gasto/Eliminar los atiende
// el bot y cambiaría la planilla sin que el POS se entere).
// ========================================
function avisarVentasTelegram_(cfg, nuevas) {
  const t = calcularTotalesPos_();
  const mensajes = [];

  if (nuevas.length > POS_CONFIG.MAX_AVISOS_INDIVIDUALES) {
    const suma = nuevas.reduce(function (s, v) { return s + v.monto; }, 0);
    let texto = '✅ ' + nuevas.length + ' ventas del POS que estaban pendientes: $' + formatearMontoPos_(suma) + '\n\n';
    texto += bloqueTotalesPos_(t.totalDia, t.totalMes, t);
    mensajes.push(texto);
  } else {
    // Totales "hasta esa venta": a los finales se les restan las ventas
    // nuevas posteriores del mismo lote, para que cada aviso muestre el
    // acumulado correcto y no el mismo número repetido.
    nuevas.forEach(function (v, i) {
      let dia = t.totalDia;
      let mes = t.totalMes;
      for (let j = i + 1; j < nuevas.length; j++) {
        if (nuevas[j].fecha === t.hoy) dia -= nuevas[j].monto;
        if (nuevas[j].fecha.indexOf(t.mesActual) === 0) mes -= nuevas[j].monto;
      }
      let primera = '✅ Monto ingresado: $' + formatearMontoPos_(v.monto) + ' · POS';
      if (v.fecha !== t.hoy) {
        primera += ' (venta del ' + v.fecha.substring(8, 10) + '/' + v.fecha.substring(5, 7) + ' ' + v.hora + ')';
      }
      mensajes.push(primera + '\n\n' + bloqueTotalesPos_(dia, mes, t));
    });
  }

  const errores = [];
  mensajes.forEach(function (texto) {
    cfg.chatIds.forEach(function (chatId) {
      const err = enviarTelegramPos_(cfg.telegramToken, chatId, texto);
      if (err) errores.push(chatId + ': ' + err);
    });
  });
  if (errores.length) throw new Error(errores.join(' | '));
}

function bloqueTotalesPos_(dia, mes, t) {
  let texto = '💰 Ingreso día: $' + formatearNumeroPos_(dia) + '\n' +
              '📅 Ingreso mes: $' + formatearNumeroPos_(mes) + '\n';
  if (t.totalMercaderia > 0 || t.totalDesperdicio > 0) {
    texto += '\n\n📦 Mercadería: $' + formatearNumeroPos_(t.totalMercaderia);
    texto += '\n🗑️ Desperdicio: $' + formatearNumeroPos_(t.totalDesperdicio);
  }
  return texto;
}

// Devuelve null si salió bien, o el texto del error.
function enviarTelegramPos_(token, chatId, texto) {
  const url = POS_CONFIG.TELEGRAM_API_BASE + '/bot' + token + '/sendMessage';
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML' }),
    muteHttpExceptions: true,
  });
  let cuerpo = {};
  try { cuerpo = JSON.parse(resp.getContentText()); } catch (err) { cuerpo = {}; }
  if (resp.getResponseCode() === 200 && cuerpo.ok) return null;
  return 'HTTP ' + resp.getResponseCode() + (cuerpo.description ? ' ' + cuerpo.description : '');
}

// Igual que formatearNumero() del bot: redondea y usa punto de miles.
function formatearNumeroPos_(num) {
  return Math.round(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Monto de una venta: con centavos si los tiene (2561.5 → "2.561,50").
function formatearMontoPos_(num) {
  const centavos = Math.round(num * 100);
  const entero = Math.floor(centavos / 100);
  const resto = centavos % 100;
  let s = formatearNumeroPos_(entero);
  if (resto) s += ',' + String(resto).padStart(2, '0');
  return s;
}

function responderJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ========================================
// PRUEBAS MANUALES DESDE EL EDITOR
// (elegir la función en el desplegable de ▶ Ejecutar y mirar el registro)
// ========================================

// Revisa que las tres propiedades estén cargadas (sin mostrar las claves).
function verificarPropiedadesPos() {
  const cfg = leerConfigPos_();
  Logger.log('POS_TOKEN: ' + (cfg.posToken ? 'OK (' + cfg.posToken.length + ' caracteres)' : 'FALTA'));
  Logger.log('TELEGRAM_TOKEN: ' + (cfg.telegramToken ? 'OK' : 'FALTA'));
  Logger.log('TELEGRAM_CHAT_ID: ' + (cfg.chatIds.length ? cfg.chatIds.join(', ') : 'FALTA'));
}

// Solo manda un mensaje de prueba al grupo; no toca la planilla.
// Sirve también para autorizar el permiso de conexión externa.
function probarTelegramPos() {
  const cfg = leerConfigPos_();
  if (!cfg.telegramToken || !cfg.chatIds.length) {
    Logger.log('Faltan TELEGRAM_TOKEN y/o TELEGRAM_CHAT_ID en Propiedades de script.');
    return;
  }
  cfg.chatIds.forEach(function (chatId) {
    const err = enviarTelegramPos_(cfg.telegramToken, chatId, '🔧 Prueba de avisos del POS: conexión OK.');
    Logger.log(chatId + ': ' + (err ? 'ERROR ' + err : 'enviado'));
  });
}

// Registra una venta de $1 y manda el aviso. Borrar la fila después.
function probarVentaPos() {
  const cfg = leerConfigPos_();
  const ahora = new Date();
  const r = procesarYAvisar_({
    origen: 'pos',
    token: cfg.posToken,
    ventas: [{
      id: 'prueba-' + ahora.getTime(),
      fecha: Utilities.formatDate(ahora, POS_CONFIG.TIMEZONE, 'yyyy-MM-dd'),
      hora: Utilities.formatDate(ahora, POS_CONFIG.TIMEZONE, 'HH:mm'),
      monto: 1,
    }],
  });
  Logger.log(JSON.stringify(r));
}

// Muestra en el registro los gastos del mes en curso, como los ve el POS.
function probarGastosPos() {
  const cfg = leerConfigPos_();
  const mes = Utilities.formatDate(new Date(), POS_CONFIG.TIMEZONE, 'yyyy-MM');
  const r = leerGastosPos_({ token: cfg.posToken, mes: mes }, cfg);
  if (!r.ok) { Logger.log(JSON.stringify(r)); return; }
  Logger.log(mes + ': ' + r.gastos.length + ' gastos, ' + r.proveedores.length + ' proveedores en la lista');
  r.gastos.slice(-10).forEach(function (g) {
    Logger.log(g.fecha + ' ' + g.hora + '  ' + g.detalle + '  ' + g.monto + (g.pagado ? '' : '  (a pagar)'));
  });
}

// Muestra en el registro cuantas ventas "cliente" hay en toda la planilla,
// como las trae el importador del POS.
function probarVentasPos() {
  const cfg = leerConfigPos_();
  const r = leerVentasPos_({ token: cfg.posToken }, cfg);
  if (!r.ok) { Logger.log(JSON.stringify(r)); return; }
  Logger.log(r.ventas.length + ' ventas "cliente" en toda la planilla');
  r.ventas.slice(-10).forEach(function (v) {
    Logger.log(v.fecha + ' ' + v.hora + '  $' + v.monto);
  });
}

// Muestra en el registro lo que el POS copia a su base: filas por tipo.
function probarPlanillaPos() {
  const cfg = leerConfigPos_();
  const r = leerPlanillaPos_({ token: cfg.posToken }, cfg);
  if (!r.ok) { Logger.log(JSON.stringify(r)); return; }
  const porTipo = {};
  r.movimientos.forEach(function (m) {
    const t = m.tipo === 'cliente' ? 'cliente' : 'gastos y otros';
    porTipo[t] = (porTipo[t] || 0) + 1;
  });
  Logger.log(r.hojas + ' hojas, ' + r.movimientos.length + ' filas: ' + JSON.stringify(porTipo) +
    ', ' + r.proveedores.length + ' proveedores en la lista');
}
