// ========================================
// OBTENER NOMBRE DE HOJA ACTUAL (POR MES)
// ----------------------------------------
// 'yyyy-MM' en vez de 'yyyy': la hoja "en caliente" donde pega
// el bot en cada mensaje queda acotada a ~1 mes de filas, en vez
// de acumular todo el año. Ver archivarMesAnteriorSiCorresponde_
// más abajo para el cierre de mes.
// ========================================
function getSheetName() {
  const ahora = new Date();
  return Utilities.formatDate(ahora, CONFIG.TIMEZONE, 'yyyy-MM');
}

// ========================================
// OBTENER O CREAR HOJA DEL MES EN CURSO
// ========================================
function getOrCreateSheet() {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheetName = getSheetName();

  let sheet = spreadsheet.getSheetByName(sheetName);

  // Si la hoja NO existe (arrancó un mes nuevo), primero archivar
  // el mes recién terminado en la hoja anual antes de crear la nueva.
  if (!sheet) {
    archivarMesAnteriorSiCorresponde_(spreadsheet, sheetName);

    Logger.log(`📄 Creando nueva hoja: ${sheetName}`);
    sheet = spreadsheet.insertSheet(sheetName);

    // Configurar encabezados
    const headers = ['Fecha', 'Hora', 'Proveedor', 'Monto', 'Pagado'];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

    // Formato de encabezados
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#4285f4')
      .setFontColor('#ffffff');

    // Ajustar anchos de columna
    sheet.setColumnWidth(1, 100); // Fecha
    sheet.setColumnWidth(2, 80);  // Hora
    sheet.setColumnWidth(3, 200); // Proveedor
    sheet.setColumnWidth(4, 100); // Monto
    sheet.setColumnWidth(5, 80);  // Pagado

    // Congelar fila de encabezados
    sheet.setFrozenRows(1);

    Logger.log(`✅ Hoja creada: ${sheetName}`);
  }

  return sheet;
}

// ========================================
// ARCHIVAR MES ANTERIOR AL EMPEZAR UNO NUEVO
// ----------------------------------------
// Se dispara sola con el primer mensaje del mes: mueve las filas
// del mes recién terminado (ej. "2026-08") al final de la hoja
// anual (ej. "2026", se crea si no existe) y borra la hoja
// mensual. Así la hoja "en caliente" nunca acumula más de ~1 mes.
// Los reportes del dashboard (getFilasDelAño) siguen funcionando
// igual: ya unen hojas "yyyy" y "yyyy-MM" de un mismo año.
// ========================================
function archivarMesAnteriorSiCorresponde_(spreadsheet, sheetNameNuevo) {
  const mesAnterior = getMesAnteriorNombre_(sheetNameNuevo);
  const sheetAnterior = spreadsheet.getSheetByName(mesAnterior);
  if (!sheetAnterior) return; // nada pendiente de archivar

  const añoAnterior = mesAnterior.substring(0, 4);
  let archivo = spreadsheet.getSheetByName(añoAnterior);
  if (!archivo) archivo = crearHojaAnualVacia_(spreadsheet, añoAnterior);

  const datos = sheetAnterior.getDataRange().getValues().slice(1).filter(function (f) { return f[0]; });
  if (datos.length > 0) {
    archivo.getRange(archivo.getLastRow() + 1, 1, datos.length, 5).setValues(datos);
  }

  spreadsheet.deleteSheet(sheetAnterior);
  Logger.log(`📦 Mes "${mesAnterior}" archivado en "${añoAnterior}" (${datos.length} filas) y hoja mensual eliminada.`);
}

// ========================================
// NOMBRE DEL MES ANTERIOR A UNA HOJA 'yyyy-MM'
// ========================================
function getMesAnteriorNombre_(sheetNameActual) {
  const partes = sheetNameActual.split('-');
  const año = parseInt(partes[0], 10);
  const mes = parseInt(partes[1], 10); // 1-12

  const fecha = new Date(año, mes - 1, 1);
  fecha.setMonth(fecha.getMonth() - 1);

  const mesNum = fecha.getMonth() + 1;
  return fecha.getFullYear() + '-' + String(mesNum).padStart(2, '0');
}

// ========================================
// BUSCAR FILA "CLIENTE" (SIN CLASIFICAR) POR MONTO
// ----------------------------------------
// Reemplaza el patrón anterior de traer TODA la hoja a memoria
// (getDataRange().getValues()) y recorrerla en JS. TextFinder
// busca del lado del servidor de Sheets, mucho más rápido a
// medida que la hoja crece durante el mes.
// ========================================
function buscarFilaClientePorMonto_(sheet, monto) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  const rangoMonto = sheet.getRange(2, 4, lastRow - 1, 1); // columna Monto
  const coincidencias = rangoMonto.createTextFinder(String(monto)).matchEntireCell(true).findAll();

  // De abajo hacia arriba: la coincidencia más reciente sin clasificar
  for (let i = coincidencias.length - 1; i >= 0; i--) {
    const fila = coincidencias[i].getRow();
    if (sheet.getRange(fila, 3).getValue() === 'cliente') {
      return fila;
    }
  }
  return -1;
}

// ========================================
// BUSCAR FILA POR |MONTO| (PARA ELIMINAR)
// ========================================
function buscarFilaPorMontoAbs_(sheet, monto) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return -1;

  const rangoMonto = sheet.getRange(2, 4, lastRow - 1, 1);
  const coincidencias = rangoMonto.createTextFinder(String(monto)).matchEntireCell(true).findAll()
    .concat(rangoMonto.createTextFinder(String(-monto)).matchEntireCell(true).findAll());

  if (!coincidencias.length) return -1;
  coincidencias.sort(function (a, b) { return a.getRow() - b.getRow(); });
  return coincidencias[coincidencias.length - 1].getRow();
}

// ========================================
// OBTENER O CREAR HOJA DE PROVEEDORES
// ========================================
function getOrCreateProveedoresSheet() {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  let sheet = spreadsheet.getSheetByName(CONFIG.PROVEEDORES_SHEET_NAME);

  // Si la hoja NO existe, crearla y sembrarla con la lista que antes estaba en el código
  if (!sheet) {
    Logger.log(`📄 Creando hoja de proveedores: ${CONFIG.PROVEEDORES_SHEET_NAME}`);
    sheet = spreadsheet.insertSheet(CONFIG.PROVEEDORES_SHEET_NAME);

    sheet.getRange(1, 1).setValue('Proveedor');
    sheet.getRange(1, 1)
      .setFontWeight('bold')
      .setBackground('#4285f4')
      .setFontColor('#ffffff');
    sheet.setColumnWidth(1, 220);
    sheet.setFrozenRows(1);

    if (PROVEEDORES_SEED.length > 0) {
      sheet.getRange(2, 1, PROVEEDORES_SEED.length, 1)
        .setValues(PROVEEDORES_SEED.map(p => [p]));
    }

    Logger.log(`✅ Hoja de proveedores creada y sembrada con ${PROVEEDORES_SEED.length} proveedores`);
  }

  return sheet;
}

// ========================================
// OBTENER LISTA DE PROVEEDORES (DESDE LA HOJA)
// ========================================
function getProveedores() {
  const sheet = getOrCreateProveedoresSheet();
  const datos = sheet.getDataRange().getValues();

  return datos
    .slice(1) // saltear encabezado
    .map(fila => String(fila[0]).trim())
    .filter(nombre => nombre.length > 0);
}

// ========================================
// AGREGAR PROVEEDOR
// ========================================
function agregarProveedor(nombre) {
  nombre = String(nombre || '').trim();

  if (!nombre) {
    throw new Error('El nombre no puede estar vacío');
  }
  if (nombre.indexOf(':') !== -1) {
    throw new Error('El nombre no puede contener ":"');
  }

  const yaExiste = getProveedores().some(p => p.toLowerCase() === nombre.toLowerCase());
  if (yaExiste) {
    throw new Error('Ese proveedor ya existe');
  }

  getOrCreateProveedoresSheet().appendRow([nombre]);
  return getProveedores();
}

// ========================================
// ELIMINAR PROVEEDOR
// ========================================
function eliminarProveedor(nombre) {
  const sheet = getOrCreateProveedoresSheet();
  const datos = sheet.getDataRange().getValues();

  for (let i = 1; i < datos.length; i++) {
    if (String(datos[i][0]).trim() === nombre) {
      sheet.deleteRow(i + 1);
      return getProveedores();
    }
  }

  throw new Error('No se encontró ese proveedor');
}

// ========================================
// REGISTRAR INGRESO EN GOOGLE SHEETS
// ========================================
function registrarIngreso(monto, tipo = 'cliente') {
  const sheet = getOrCreateSheet(); // ← Cambio principal
  
  const ahora = new Date();
  const fecha = Utilities.formatDate(ahora, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const hora = Utilities.formatDate(ahora, CONFIG.TIMEZONE, 'HH:mm');
  
  sheet.appendRow([fecha, hora, tipo, monto, true]);
  invalidarCacheTotales_();

  return calcularTotales();
}

// ========================================
// OBTENER TODAS LAS FILAS DE UN AÑO
// ----------------------------------------
// Junta la hoja "AAAA" con cualquier hoja vieja tipo "AAAA-MM"
// que haya quedado sin migrar (ver migracion.gs). Así ningún
// movimiento "desaparece" del dashboard ni de los totales
// solo porque todavía no se corrió la migración a mano.
// ========================================
function getFilasDelAño(año) {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const patron = new RegExp('^' + año + '(-\\d{2})?$');
  const filas = [];

  spreadsheet.getSheets().forEach(function (sheet) {
    if (!patron.test(sheet.getName())) return;
    const datos = sheet.getDataRange().getValues();
    for (let i = 1; i < datos.length; i++) {
      if (datos[i][0]) filas.push(datos[i]);
    }
  });

  return filas;
}

// ========================================
// CALCULAR TOTALES
// ----------------------------------------
// Ahora lee SOLO la hoja del mes en curso (getOrCreateSheet), no
// todo el año: como esa hoja se archiva y arranca vacía cada mes
// (ver archivarMesAnteriorSiCorresponde_), el escaneo queda
// acotado a ~1 mes de filas en vez de crecer todo el año.
// Además cachea el resultado unos segundos (CacheService) para
// ráfagas de mensajes seguidos; se invalida a mano con
// invalidarCacheTotales_() en cada escritura (ver sheet.gs/
// webhook.gs/photos.gs) para que nunca muestre un total viejo.
// ========================================
function calcularTotales() {
  const ahora = new Date();
  const hoy = Utilities.formatDate(ahora, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const mesActual = Utilities.formatDate(ahora, CONFIG.TIMEZONE, 'yyyy-MM');

  const cache = CacheService.getScriptCache();
  const cacheKey = 'totales_' + mesActual;
  const cacheado = cache.get(cacheKey);
  if (cacheado) return JSON.parse(cacheado);

  const sheet = getOrCreateSheet(); // hoja del mes en curso
  const datos = sheet.getDataRange().getValues();

  let totalDia = 0;
  let totalMes = 0;
  let totalGastos = 0;
  let totalMercaderia = 0;
  let totalDesperdicio = 0;

  for (let i = 1; i < datos.length; i++) {
    const fila = datos[i];
    const fechaFila = normalizarFecha(fila[0]);
    const tipo = fila[2];
    const montoFila = parseFloat(fila[3]) || 0;
    const pagado = fila[4];

    // 💰 Ingreso día (solo clientes de hoy)
    if (fechaFila === hoy && tipo === 'cliente') {
      totalDia += montoFila;
    }

    // 📅 Ingreso mes (clientes + proveedores + gastos PAGADOS)
    // El startsWith queda como chequeo defensivo por si alguna vez
    // se pega a mano una fila de otro mes en esta hoja.
    if (fechaFila.startsWith(mesActual) && pagado === true) {
      totalMes += montoFila; // Los egresos ya son negativos

      // Separar por tipo para el cálculo de ganancia
      if (tipo === TIPOS_PAGO.GASTO) {
        totalGastos += Math.abs(montoFila);
      } else if (tipo === TIPOS_PAGO.MERCADERIA) {
        totalMercaderia += Math.abs(montoFila);
      } else if (tipo === TIPOS_PAGO.DESPERDICIO) {
        totalDesperdicio += Math.abs(montoFila);
      }
    }
  }

  // 📊 Ganancia estimada
  // Base: totalMes SIN gasto, mercadería, desperdicio
  const baseSinExcluidos = totalMes + totalGastos + totalMercaderia + totalDesperdicio;
  const gananciaEstimada = (baseSinExcluidos * CONFIG.GANANCIA_PORCENTAJE) - totalGastos;

  const resultado = {
    totalDia: totalDia,
    totalMes: totalMes,
    gananciaEstimada: gananciaEstimada,
    totalMercaderia: totalMercaderia,
    totalDesperdicio: totalDesperdicio
  };

  cache.put(cacheKey, JSON.stringify(resultado), 20); // 20s: red de seguridad para ráfagas
  return resultado;
}

// ========================================
// INVALIDAR CACHE DE TOTALES
// ----------------------------------------
// Llamar SIEMPRE justo después de escribir en la hoja del mes en
// curso (appendRow / setValue / deleteRow), antes de leer totales
// de nuevo. Si se olvida en algún lugar nuevo, el peor caso es
// mostrar un total desactualizado por hasta 20s, nunca datos mal
// escritos en la hoja.
// ========================================
function invalidarCacheTotales_() {
  const mesActual = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM');
  CacheService.getScriptCache().remove('totales_' + mesActual);
}
