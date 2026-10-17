// ========================================
// DIAGNÓSTICO — correr a mano cuando el bot no responde.
// Solo LEE, no escribe nada en la hoja ni en Telegram.
// Cómo usarlo: elegí "diagnosticoCompleto" en el desplegable
// de al lado de ▶ Ejecutar, corré, y mirá Ver > Registros.
// Pegame ese texto si algo da ❌.
// ========================================
function diagnosticoCompleto() {
  const lineas = [];
  lineas.push('===== DIAGNÓSTICO =====');

  // 1) ¿Qué URL tiene Telegram registrada, y hubo errores entregando mensajes?
  // (Nota: no comparamos contra ScriptApp.getService().getUrl() porque al
  // correr esto a mano desde el editor esa función devuelve la URL /dev de
  // pruebas, no la del deployment real — da falsa alarma siempre. Lo que
  // importa de verdad es lo que Telegram reporta acá abajo.)
  try {
    const resp = UrlFetchApp.fetch(CONFIG.TELEGRAM_API_BASE + '/bot' + CONFIG.TELEGRAM_TOKEN + '/getWebhookInfo');
    const info = JSON.parse(resp.getContentText()).result;
    lineas.push('1) Webhook registrado en Telegram: ' + info.url);
    lineas.push('   Mensajes pendientes sin entregar: ' + info.pending_update_count);
    if (info.last_error_message) {
      const fecha = info.last_error_date ? new Date(info.last_error_date * 1000) : null;
      lineas.push('   ❌ Último error reportado por Telegram: ' + info.last_error_message + (fecha ? ' (' + fecha + ')' : ''));
    } else {
      lineas.push('   ✅ Sin errores reportados por Telegram');
    }
  } catch (e) {
    lineas.push('1) ⚠️ No se pudo consultar getWebhookInfo: ' + e);
  }

  // 2) ¿Se puede acceder a la hoja del año actual? ¿Cuál es la última fila?
  try {
    const sheet = getOrCreateSheet();
    lineas.push('2) ✅ getOrCreateSheet() OK → hoja "' + sheet.getName() + '", ' + sheet.getLastRow() + ' filas.');
    const ultima = sheet.getRange(sheet.getLastRow(), 1, 1, 5).getValues()[0];
    lineas.push('   Última fila (cruda): fecha=' + ultima[0] + ' hora=' + ultima[1] + ' tipo=' + ultima[2] + ' monto=' + ultima[3] + ' pagado=' + ultima[4]);
    lineas.push('   Última fila (normalizada): fecha=' + normalizarFecha(ultima[0]) + ' hora=' + normalizarHora(ultima[1]));
    lineas.push('   👉 Comparalo con la hora en que mandaste el último mensaje de prueba por Telegram.');
  } catch (e) {
    lineas.push('2) ❌ getOrCreateSheet() falló: ' + e);
  }

  // 3) ¿Se puede leer la lista de proveedores?
  try {
    const proveedores = getProveedores();
    lineas.push('3) ✅ getProveedores() OK → ' + proveedores.length + ' proveedores.');
  } catch (e) {
    lineas.push('3) ❌ getProveedores() falló: ' + e);
  }

  // 4) ¿Hay hojas fragmentadas del mismo año (ej. "2026" y "2026-07"
  //    sin migrar) y qué tipo de dato tiene la columna Fecha?
  //    Esto es lo que hacía que el dashboard mostrara 0 en métricas.
  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    const añoActual = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy');
    const patron = new RegExp('^' + añoActual + '(-\\d{2})?$');
    const hojasDelAño = spreadsheet.getSheets()
      .map(function (s) { return s.getName(); })
      .filter(function (nombre) { return patron.test(nombre); });

    lineas.push('4) Hojas de ' + añoActual + ' encontradas: ' + hojasDelAño.join(', '));
    if (hojasDelAño.length > 1) {
      lineas.push('   ⚠️ Hay más de una hoja para este año. El dashboard ya las junta a todas automáticamente, pero conviene correr migrarDatosUnaVez() (migracion.gs) cuando haya un momento tranquilo para dejar todo en una sola.');
    } else {
      lineas.push('   ✅ Una sola hoja para este año, sin fragmentar.');
    }

    const sheetActual = getOrCreateSheet();
    if (sheetActual.getLastRow() > 1) {
      const desde = Math.max(2, sheetActual.getLastRow() - 2);
      const muestra = sheetActual.getRange(desde, 1, sheetActual.getLastRow() - desde + 1, 1).getValues();
      muestra.forEach(function (f) {
        const valor = f[0];
        const esDate = valor instanceof Date;
        lineas.push('   Celda Fecha=' + valor + ' → ' + (esDate ? 'Date ✅' : 'texto suelto (tipo ' + typeof valor + ') — normalizarFecha() ya lo maneja bien'));
      });
    }
  } catch (e) {
    lineas.push('4) ❌ Chequeo de hojas/fechas falló: ' + e);
  }

  const texto = lineas.join('\n');
  Logger.log(texto);
  return texto;
}
