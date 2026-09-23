// ========================================
// WEBHOOK - Recibe mensajes de Telegram
// ========================================
function doPost(e) {
  try {
    Logger.log('=== INICIO doPost ===');

    const data = JSON.parse(e.postData.contents);

    // Ventas que manda el POS de la balanza (ver pos.gs). Van antes
    // que todo lo de Telegram y no se loguean enteras (traen token).
    if (data.origen === 'pos') {
      return recibirVentasPos_(data);
    }

    Logger.log('Data recibida: ' + JSON.stringify(data));

    // Manejar callbacks de botones
    if (data.callback_query) {
      handleCallback(data.callback_query);
      return HtmlService.createHtmlOutput("");
    }

    // Verificar que sea un mensaje de texto
    if (!data.message || !data.message.text) {
      Logger.log('No es un mensaje de texto válido');
      return HtmlService.createHtmlOutput("");
    }

    const chatId = data.message.chat.id;
    const messageText = data.message.text.trim();
    const username = data.message.from.username || data.message.from.first_name || 'usuario';
    Logger.log('ChatId: ' + chatId + ' - Username: ' + username + ' - Texto: ' + messageText);

    // Validar que sea un número
    const monto = parseInt(messageText.replace(/\D/g, ''));

    if (isNaN(monto) || monto <= 0) {
      Logger.log('No es un número válido');
      sendMessage(chatId, '❌ Por favor envía solo números válidos');
      return HtmlService.createHtmlOutput("");
    }

    Logger.log('Monto válido: ' + monto);

    // Registrar como CLIENTE por defecto
    const resultado = registrarIngreso(monto, 'cliente');
    Logger.log('Resultado registro: ' + JSON.stringify(resultado));

    // Enviar respuesta con botones (ahora incluye username)
    const mensaje = formatearRespuesta(monto, resultado);
    sendMessageWithButtons(chatId, mensaje, monto, username);

    Logger.log('=== FIN doPost exitoso ===');

    return HtmlService.createHtmlOutput("");

  } catch (error) {
    Logger.log('ERROR en doPost: ' + error.toString());
    return HtmlService.createHtmlOutput("");
  }
}

// ========================================
// MANEJAR CALLBACKS DE BOTONES
// ========================================
function handleCallback(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;
  const username = callbackQuery.from.username || callbackQuery.from.first_name || 'usuario';

  Logger.log(`Callback recibido: ${data}`);
  Logger.log(`🔍 FULL CALLBACK: ${JSON.stringify(callbackQuery)}`);
  Logger.log(`🔍 Data: ${data}`);
  Logger.log(`👤 Username: ${username}`);
  
  const partes = data.split(':');
  const accion = partes[0];

  // MOSTRAR PROVEEDORES "A PAGAR"
  if (accion === 'mostrar_apagar' && partes.length === 3) {
    const monto = parseInt(partes[1]);
    const user = partes[2];
    editMessageWithProveedoresAPagar(chatId, messageId, '💳 A pagar:', monto, user);
    answerCallback(callbackQuery.id);
    return;
  }

  // PROVEEDORES
  if (accion === 'proveedor' && partes.length === 3) {
    const monto = parseInt(partes[1]);
    const user = partes[2];
    mostrarProveedores(chatId, messageId, monto, user);
    answerCallback(callbackQuery.id);
    return;
  }

  if (accion === 'selproveedor' && partes.length === 4) {
    const proveedor = partes[1];
    const monto = parseInt(partes[2]);
    const user = partes[3];
    registrarProveedor(chatId, messageId, proveedor, monto);
    answerCallback(callbackQuery.id);
    return;
  }

  if (accion === 'pagar' && partes.length === 4) {
    const proveedor = partes[1];
    const monto = parseInt(partes[2]);
    const user = partes[3];
    registrarProveedorPendiente(chatId, messageId, proveedor, monto);
    answerCallback(callbackQuery.id);
    return;
  }

  // GASTOS - Mostrar opciones
  if (accion === 'gasto' && partes.length === 3) {
    const monto = parseInt(partes[1]);
    const user = partes[2];
    mostrarOpcionesPago(chatId, messageId, monto, user);
    answerCallback(callbackQuery.id);
    return;
  }

  // REGISTRAR TIPO DE PAGO (AQUÍ SE USA EL USERNAME)
  if (accion === 'tipopago' && partes.length === 4) {
    const tipo = partes[1];
    const monto = parseInt(partes[2]);
    const user = partes[3];
    registrarPago(chatId, messageId, tipo, monto, user);
    answerCallback(callbackQuery.id);
    return;
  }

  // ELIMINAR
  if (accion === 'eliminar' && partes.length === 3) {
    const monto = parseInt(partes[1]);
    const user = partes[2];
    eliminarRegistro(chatId, messageId, monto);
    answerCallback(callbackQuery.id);
    return;
  }

  answerCallback(callbackQuery.id);
}

// ========================================
// MOSTRAR LISTA DE PROVEEDORES
// ========================================
function mostrarProveedores(chatId, messageId, monto, username) {
  editMessageWithProveedores(chatId, messageId, `🏭 Proveedor:`, monto, username);
}

// ========================================
// REGISTRAR PROVEEDOR (PAGADO)
// ========================================
function registrarProveedor(chatId, messageId, proveedor, monto) {
  const sheet = getOrCreateSheet();
  const fila = buscarFilaClientePorMonto_(sheet, monto);

  if (fila === -1) {
    editMessage(chatId, messageId, '❌ No se encontró el registro');
    return;
  }

  sheet.getRange(fila, 3).setValue(proveedor);
  sheet.getRange(fila, 4).setValue(-monto);
  sheet.getRange(fila, 5).setValue(true);
  invalidarCacheTotales_();

  const resultado = calcularTotales();
  const mensaje = `✅💰 Registrado: ${proveedor} (PAGADO)
      💰 Monto: -$${formatearNumero(monto)}`;

  editMessage(chatId, messageId, mensaje);
}

// ========================================
// REGISTRAR PROVEEDOR (A PAGAR)
// ========================================
function registrarProveedorPendiente(chatId, messageId, proveedor, monto) {
  const sheet = getOrCreateSheet();
  const fila = buscarFilaClientePorMonto_(sheet, monto);

  if (fila === -1) {
    editMessage(chatId, messageId, '❌ No se encontró el registro');
    return;
  }

  sheet.getRange(fila, 3).setValue(proveedor);
  sheet.getRange(fila, 4).setValue(-monto);
  sheet.getRange(fila, 5).setValue(false);
  invalidarCacheTotales_();

  const resultado = calcularTotales();
  const mensaje = `⏳ Registrado: ${proveedor} (A PAGAR)
      💰 Monto: -$${formatearNumero(monto)}`;

  editMessage(chatId, messageId, mensaje);
}

// ========================================
// REGISTRAR PAGO (ACTUALIZADO CON USERNAME)
// ========================================
function registrarPago(chatId, messageId, tipo, monto, username) {
  const sheet = getOrCreateSheet();
  const fila = buscarFilaClientePorMonto_(sheet, monto);

  if (fila === -1) {
    editMessage(chatId, messageId, '❌ No se encontró el registro');
    return;
  }

  let montoFinal = -Math.abs(monto);

  if (tipo === TIPOS_PAGO.MERCADERIA || tipo === TIPOS_PAGO.DESPERDICIO) {
    montoFinal = -(monto * CONFIG.FACTOR_MERCADERIA_DESPERDICIO);
  }

  // Usa username en lugar de tipo
  if (tipo === TIPOS_PAGO.GASTO || tipo === TIPOS_PAGO.MERCADERIA) {
    sheet.getRange(fila, 3).setValue(username);
  } else {
    sheet.getRange(fila, 3).setValue(tipo);
  }

  sheet.getRange(fila, 4).setValue(montoFinal);
  invalidarCacheTotales_();

  const resultado = calcularTotales();

  let emoji = '💸';
  let nombre = tipo;
  let detalleMonto = Math.abs(montoFinal);

  if (tipo === TIPOS_PAGO.GASTO) {
    emoji = '💸';
    nombre = 'Gasto personal';
  } else if (tipo === TIPOS_PAGO.MERCADERIA) {
    emoji = '📦';
    nombre = 'Mercadería';
    detalleMonto = `${formatearNumero(monto)} → ${formatearNumero(Math.abs(montoFinal))}`;
  } else if (tipo === TIPOS_PAGO.DESPERDICIO) {
    emoji = '🗑️';
    nombre = 'Desperdicio';
    detalleMonto = `${formatearNumero(monto)} → ${formatearNumero(Math.abs(montoFinal))}`;
  }

  const mensaje = `${emoji} ${nombre}
💰 Monto: $${detalleMonto}

📦 Mercadería: $${formatearNumero(resultado.totalMercaderia)}
🗑️ Desperdicio: $${formatearNumero(resultado.totalDesperdicio)}`;

  editMessage(chatId, messageId, mensaje);
}

// ========================================
// ELIMINAR ÚLTIMO REGISTRO
// ========================================
function eliminarRegistro(chatId, messageId, monto) {
  const sheet = getOrCreateSheet();
  const fila = buscarFilaPorMontoAbs_(sheet, monto);

  if (fila === -1) {
    editMessage(chatId, messageId, '❌ No se encontró el registro para eliminar');
    return;
  }

  sheet.deleteRow(fila);
  invalidarCacheTotales_();

  editMessage(chatId, messageId, '⛔ Registro eliminado');
}