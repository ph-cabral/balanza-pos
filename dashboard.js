// ========================================
// SERVIR DASHBOARD WEB (GET al webapp)
// ========================================
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Fiambrería')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ========================================
// OBTENER MOVIMIENTOS EN UN RANGO DE FECHAS
// Junta datos de todas las hojas de año que toque el rango
// (por si el rango cruza el 31/12), separa ingresos vs
// gastos y calcula los totales del período.
// ========================================
function getMovimientos(fechaInicio, fechaFin) {
  if (!fechaInicio) fechaInicio = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  if (!fechaFin) fechaFin = fechaInicio;
  if (fechaFin < fechaInicio) { const tmp = fechaInicio; fechaInicio = fechaFin; fechaFin = tmp; }

  const añoInicio = parseInt(fechaInicio.substring(0, 4), 10);
  const añoFin = parseInt(fechaFin.substring(0, 4), 10);

  const filas = [];
  for (let año = añoInicio; año <= añoFin; año++) {
    filas.push.apply(filas, getFilasDelAño(año));
  }

  const ingresos = [];
  const gastos = [];
  let totalIngresado = 0;
  let totalGastado = 0;

  filas.forEach(function (fila) {
    if (!fila[0]) return;

    const fechaFila = normalizarFecha(fila[0]);
    if (fechaFila < fechaInicio || fechaFila > fechaFin) return;

    const hora = normalizarHora(fila[1]);
    const tipo = fila[2];
    const monto = parseFloat(fila[3]) || 0;
    const pagado = fila[4] === true;

    if (tipo === 'cliente') {
      ingresos.push({ fecha: fechaFila, hora: hora, monto: monto });
      totalIngresado += monto;
    } else {
      const montoAbs = Math.abs(monto);
      gastos.push({ fecha: fechaFila, hora: hora, detalle: tipo, monto: montoAbs, pagado: pagado });
      if (pagado) {
        totalGastado += montoAbs;
      }
    }
  });

  return {
    fechaInicio: fechaInicio,
    fechaFin: fechaFin,
    ingresos: ingresos,
    gastos: gastos,
    totalIngresado: totalIngresado,
    totalGastado: totalGastado,
    queda: totalIngresado - totalGastado
  };
}

// ========================================
// OBTENER MESES QUE TIENEN AL MENOS UN MOVIMIENTO
// Recorre todas las hojas de año (y las legacy "yyyy-MM" sin
// migrar) y junta los meses 'yyyy-MM' que tengan alguna fila,
// para poblar el selector de meses del gráfico de proveedores.
// ========================================
function getMesesDisponibles() {
  const spreadsheet = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const patron = /^\d{4}(-\d{2})?$/;
  const meses = {};

  spreadsheet.getSheets().forEach(function (sheet) {
    if (!patron.test(sheet.getName())) return;
    const datos = sheet.getDataRange().getValues();
    for (let i = 1; i < datos.length; i++) {
      if (!datos[i][0]) continue;
      const fecha = normalizarFecha(datos[i][0]);
      meses[fecha.substring(0, 7)] = true;
    }
  });

  return Object.keys(meses).sort().reverse();
}

// ========================================
// RESUMEN DE HOY: ingreso acumulado, promedio
// histórico (últimos 30 días con datos, sin contar
// hoy), total del mes y del año en curso, y la meta
// guardada para hoy (si hay). Alimenta el semáforo.
// ========================================
function getResumenHoy() {
  const ahora = new Date();
  const hoy = Utilities.formatDate(ahora, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const mesActual = hoy.substring(0, 7);   // 'yyyy-MM'
  const anioActual = hoy.substring(0, 4);  // 'yyyy'

  const desdeDate = new Date(ahora);
  desdeDate.setDate(desdeDate.getDate() - 30);
  const desdePromedio = Utilities.formatDate(desdeDate, CONFIG.TIMEZONE, 'yyyy-MM-dd');

  // Cubrir el año en curso completo (para el acumulado anual) y,
  // si los 30 días de referencia caen en el año anterior (ej. en
  // enero), también ese año.
  const añoInicio = Math.min(parseInt(desdePromedio.substring(0, 4), 10), parseInt(anioActual, 10));
  const añoFin = parseInt(anioActual, 10);

  const filas = [];
  for (let año = añoInicio; año <= añoFin; año++) {
    filas.push.apply(filas, getFilasDelAño(año));
  }

  const porDiaPrevio = {};
  let totalHoy = 0;
  let totalMes = 0;
  let totalAnio = 0;

  filas.forEach(function (fila) {
    if (!fila[0] || fila[2] !== 'cliente') return;

    const fechaFila = normalizarFecha(fila[0]);
    if (fechaFila > hoy) return; // nada del futuro

    const monto = parseFloat(fila[3]) || 0;

    if (fechaFila.substring(0, 4) === anioActual) {
      totalAnio += monto;
      if (fechaFila.substring(0, 7) === mesActual) totalMes += monto;
    }

    if (fechaFila === hoy) {
      totalHoy += monto;
    } else if (fechaFila >= desdePromedio) {
      porDiaPrevio[fechaFila] = (porDiaPrevio[fechaFila] || 0) + monto;
    }
  });

  const diasPrevios = Object.keys(porDiaPrevio);
  const totalPrevio = diasPrevios.reduce(function (s, f) { return s + porDiaPrevio[f]; }, 0);
  const promedio = diasPrevios.length ? totalPrevio / diasPrevios.length : 0;

  return {
    fecha: hoy,
    hoy: totalHoy,
    promedio: promedio,
    diasPromediados: diasPrevios.length,
    meta: obtenerMetaHoy(),
    totalMes: totalMes,
    totalAnio: totalAnio
  };
}

// ========================================
// META DEL DÍA (guardada en Properties, con
// clave por fecha para que cada día arranque
// sin meta salvo que se cargue una nueva)
// ========================================
function guardarMetaHoy(monto) {
  const hoy = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  PropertiesService.getScriptProperties().setProperty('meta_' + hoy, String(monto));
  return getResumenHoy();
}

function obtenerMetaHoy() {
  const hoy = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const valor = PropertiesService.getScriptProperties().getProperty('meta_' + hoy);
  return valor ? parseFloat(valor) : null;
}
