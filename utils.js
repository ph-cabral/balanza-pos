// ========================================
// FORMATEAR NÚMEROS CON SEPARADOR DE MILES
// ========================================
function formatearNumero(num) {
  return Math.round(num).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// ========================================
// NORMALIZAR FECHA DE UNA CELDA A 'yyyy-MM-dd'
// ----------------------------------------
// Bug que arregla: si la celda ya es texto (ej. "2026-07-25"),
// envolverla en `new Date("2026-07-25")` la interpreta como
// medianoche UTC. Al formatear eso en horario de Argentina
// (UTC-3) cae 3 horas antes → el día anterior (24 en vez de 25).
// Por eso NUNCA hay que re-parsear un string con `new Date()`.
// Si la celda es texto: se usa tal cual (los primeros 10
// caracteres). Si Sheets la autoconvirtió a un Date real: se
// formatea con el huso horario del negocio.
// ========================================
function normalizarFecha(valorCelda) {
  if (valorCelda instanceof Date) {
    return Utilities.formatDate(valorCelda, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }
  return String(valorCelda).trim().substring(0, 10);
}

// ========================================
// NORMALIZAR HORA DE UNA CELDA A 'HH:mm'
// ----------------------------------------
// Mismo problema que la fecha: Sheets autoconvierte el texto
// "21:12" en un valor de hora real (Date anclado al 30/12/1899,
// por eso el diagnóstico lo mostraba como "Sat Dec 30 1899...").
// Se reformatea con el mismo huso horario para recuperar "HH:mm".
// ========================================
function normalizarHora(valorCelda) {
  if (valorCelda instanceof Date) {
    return Utilities.formatDate(valorCelda, CONFIG.TIMEZONE, 'HH:mm');
  }
  return String(valorCelda).trim();
}

// ========================================
// FORMATEAR RESPUESTA
// ========================================
function formatearRespuesta(monto, resultado) {
  let mensaje = `✅ Monto ingresado: $${formatearNumero(monto)}

💰 Ingreso día: $${formatearNumero(resultado.totalDia)}
📅 Ingreso mes: $${formatearNumero(resultado.totalMes)}
`;
// 📊 Ganancia estimada: $${formatearNumero(resultado.gananciaEstimada)}

  if (resultado.totalMercaderia > 0 || resultado.totalDesperdicio > 0) {
    mensaje += `\n\n📦 Mercadería: $${formatearNumero(resultado.totalMercaderia)}`;
    mensaje += `\n🗑️ Desperdicio: $${formatearNumero(resultado.totalDesperdicio)}`;
  }

  return mensaje;
}
