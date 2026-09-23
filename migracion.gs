// ========================================
// MIGRACIÓN ÚNICA — correr a mano UNA sola vez
// ========================================
// Cómo usarla:
//   1) En el editor de Apps Script, elegí la función
//      "migrarDatosUnaVez" en el desplegable de al lado de ▶ Ejecutar.
//   2) Ejecutar. Revisá el log (Ver > Registros) para el resumen.
//   3) Si salió todo bien, podés borrar este archivo.
//
// Qué hace (no borra nada de tus datos originales):
//   - Copia todas las filas de la hoja "2026-07" al final de "2026".
//     (la hoja "2026-07" queda intacta, no se toca ni se borra)
//   - Encontré 380 filas de mayo 2025 pegadas por error dentro de la
//     hoja "2026" (fechas guardadas como texto '2025-05-17' a '2025-05-31').
//     Las mueve a la hoja "2025", donde corresponden.
//   - Si la hoja "proveedores" existe pero está vacía, la siembra con
//     la lista base de proveedores.
// ========================================
function migrarDatosUnaVez() {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const resumen = [];

  resumen.push(migrarJulioA2026_(spreadsheet));
  resumen.push(reubicarMayo2025_(spreadsheet));
  resumen.push(sembrarProveedoresSiVacia_(spreadsheet));

  const texto = resumen.join('\n');
  Logger.log('\n===== RESUMEN MIGRACIÓN =====\n' + texto);
  return texto;
}

function migrarJulioA2026_(spreadsheet) {
  const origen = spreadsheet.getSheetByName('2026-07');
  if (!origen) return 'ⓘ No existe la hoja "2026-07", nada que migrar.';

  let destino = spreadsheet.getSheetByName('2026');
  if (!destino) destino = crearHojaAnualVacia_(spreadsheet, '2026');

  const datos = origen.getDataRange().getValues().slice(1).filter(function (f) { return f[0]; });
  if (!datos.length) return 'ⓘ "2026-07" no tiene filas para migrar.';

  destino.getRange(destino.getLastRow() + 1, 1, datos.length, 5).setValues(datos);
  return '✅ Migradas ' + datos.length + ' filas de "2026-07" → "2026". ' +
    '"2026-07" queda intacta (no se borró); borrala vos a mano cuando confirmes que "2026" está bien.';
}

function reubicarMayo2025_(spreadsheet) {
  const hoja2026 = spreadsheet.getSheetByName('2026');
  const hoja2025 = spreadsheet.getSheetByName('2025');
  if (!hoja2026 || !hoja2025) return 'ⓘ Falta la hoja "2026" o "2025", no se reubicó nada.';

  const datos = hoja2026.getDataRange().getValues();
  const filasAMover = [];
  const filasAMoverIdx = [];

  for (let i = 1; i < datos.length; i++) {
    const fecha = datos[i][0];
    if (typeof fecha === 'string' && fecha.indexOf('2025-') === 0) {
      filasAMover.push(datos[i]);
      filasAMoverIdx.push(i + 1); // fila real en la hoja (1-indexed)
    }
  }

  if (!filasAMover.length) return 'ⓘ No había filas de 2025 mal ubicadas en "2026".';

  hoja2025.getRange(hoja2025.getLastRow() + 1, 1, filasAMover.length, 5).setValues(filasAMover);

  // Borrar de abajo hacia arriba para no correr los índices de fila
  filasAMoverIdx.sort(function (a, b) { return b - a; }).forEach(function (fila) {
    hoja2026.deleteRow(fila);
  });

  return '✅ Reubicadas ' + filasAMover.length + ' filas (mayo 2025) de "2026" → "2025".';
}

function sembrarProveedoresSiVacia_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(CONFIG.PROVEEDORES_SHEET_NAME);
  if (!sheet) return 'ⓘ No existe la hoja "proveedores" todavía (se crea sola la primera vez que se abre Configuración en el dashboard).';

  const filas = sheet.getDataRange().getValues().filter(function (f) { return f[0]; });
  if (filas.length > 0) return 'ⓘ "proveedores" ya tiene ' + filas.length + ' fila(s) cargada(s), no se tocó.';

  sheet.getRange(1, 1).setValue('Proveedor');
  sheet.getRange(1, 1).setFontWeight('bold').setBackground('#4285f4').setFontColor('#ffffff');
  sheet.setColumnWidth(1, 220);
  sheet.setFrozenRows(1);
  sheet.getRange(2, 1, PROVEEDORES_SEED.length, 1).setValues(PROVEEDORES_SEED.map(function (p) { return [p]; }));

  return '✅ "proveedores" estaba vacía → sembrada con ' + PROVEEDORES_SEED.length + ' nombres.';
}

function crearHojaAnualVacia_(spreadsheet, nombre) {
  const sheet = spreadsheet.insertSheet(nombre);
  const headers = ['Fecha', 'Hora', 'Proveedor', 'Monto', 'Pagado'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#4285f4').setFontColor('#ffffff');
  sheet.setFrozenRows(1);
  return sheet;
}

// ========================================
// MIGRACIÓN ÚNICA #2 — correr a mano UNA sola vez, al activar
// el archivado mensual (ver sheet.gs: getSheetName ahora es
// 'yyyy-MM' en vez de 'yyyy').
// ========================================
// Por qué hace falta: hasta ahora TODO el año caía en la hoja
// "2026". Si no se corre esto, el bot va a crear una hoja mensual
// nueva vacía (ej. "2026-08") y las ventas de este mes que ya
// están adentro de "2026" van a quedar invisibles para el ingreso
// del día/mes (calcularTotales ahora solo mira la hoja mensual).
// No se pierden datos: siguen en "2026" y el dashboard los sigue
// sumando igual. Es solo para que el bot vuelva a verlos HOY.
//
// Cómo usarla: elegí "separarMesActualDelAnual" en el desplegable
// de al lado de ▶ Ejecutar, corré, y mirá Ver > Registros.
// Es seguro correrla más de una vez (si no hay nada que mover, no
// hace nada).
// ========================================
function separarMesActualDelAnual() {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const nombreMes = getSheetName(); // 'yyyy-MM' del mes en curso
  const año = nombreMes.substring(0, 4);

  const hojaAnual = spreadsheet.getSheetByName(año);
  if (!hojaAnual) {
    const msg = `ⓘ No existe la hoja "${año}", nada que separar.`;
    Logger.log(msg);
    return msg;
  }

  const datos = hojaAnual.getDataRange().getValues();
  const filasDelMes = [];
  const filasDelMesIdx = [];

  for (let i = 1; i < datos.length; i++) {
    if (!datos[i][0]) continue;
    const fecha = normalizarFecha(datos[i][0]);
    if (fecha.startsWith(nombreMes)) {
      filasDelMes.push(datos[i]);
      filasDelMesIdx.push(i + 1);
    }
  }

  if (!filasDelMes.length) {
    const msg = `ⓘ "${año}" no tenía filas de ${nombreMes}, nada que separar.`;
    Logger.log(msg);
    return msg;
  }

  const hojaMes = getOrCreateSheet(); // crea "2026-08" con encabezados si no existe
  hojaMes.getRange(hojaMes.getLastRow() + 1, 1, filasDelMes.length, 5).setValues(filasDelMes);

  // Borrar de abajo hacia arriba para no correr los índices de fila
  filasDelMesIdx.sort(function (a, b) { return b - a; }).forEach(function (fila) {
    hojaAnual.deleteRow(fila);
  });

  invalidarCacheTotales_();

  const msg = `✅ Separadas ${filasDelMes.length} filas de ${nombreMes} → hoja mensual nueva. "${año}" queda con el resto de los meses ya cerrados.`;
  Logger.log(msg);
  return msg;
}
