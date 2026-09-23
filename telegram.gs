// ========================================
// ENVIAR MENSAJE SIMPLE
// ========================================
function sendMessage(chatId, text) {
  const url = `${CONFIG.TELEGRAM_API_BASE}/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`;

  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML'
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  UrlFetchApp.fetch(url, options);
}

// ========================================
// ENVIAR MENSAJE CON BOTONES PRINCIPALES (ACTUALIZADO)
// ========================================
function sendMessageWithButtons(chatId, text, monto, username) {
  const url = `${CONFIG.TELEGRAM_API_BASE}/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`;

  const keyboard = {
    inline_keyboard: [[
      { text: '📦 Proveedor', callback_data: `proveedor:${monto}:${username}` },
      { text: '💸 Gasto', callback_data: `gasto:${monto}:${username}` },
      { text: '🗑️ Eliminar', callback_data: `eliminar:${monto}:${username}` }
    ]]
  };

  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: keyboard
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  UrlFetchApp.fetch(url, options);
}

// ========================================
// EDITAR MENSAJE
// ========================================
function editMessage(chatId, messageId, text) {
  const url = `${CONFIG.TELEGRAM_API_BASE}/bot${CONFIG.TELEGRAM_TOKEN}/editMessageText`;

  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'HTML'
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  UrlFetchApp.fetch(url, options);
}

// ========================================
// MOSTRAR PROVEEDORES (CON SCROLL) - ACTUALIZADO
// ========================================
function editMessageWithProveedores(chatId, messageId, text, monto, username) {
  const url = `${CONFIG.TELEGRAM_API_BASE}/bot${CONFIG.TELEGRAM_TOKEN}/editMessageText`;
  const proveedores = getProveedores();

  // Crear botones en grupos de 3 por fila
  const botones = [];
  for (let i = 0; i < proveedores.length; i += 3) {
    const fila = [];
    for (let j = 0; j < 3 && (i + j) < proveedores.length; j++) {
      const proveedor = proveedores[i + j];
      fila.push({
        text: proveedor,
        callback_data: `selproveedor:${proveedor}:${monto}:${username}`
      });
    }
    botones.push(fila);
  }

  // Agregar botón "A pagar" al final
  botones.push([{
    text: '💳 A pagar',
    callback_data: `mostrar_apagar:${monto}:${username}`
  }]);

  const keyboard = {
    inline_keyboard: botones
  };

  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: keyboard
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  UrlFetchApp.fetch(url, options);
}

// ========================================
// MOSTRAR PROVEEDORES "A PAGAR" - ACTUALIZADO
// ========================================
function editMessageWithProveedoresAPagar(chatId, messageId, text, monto, username) {
  const url = `${CONFIG.TELEGRAM_API_BASE}/bot${CONFIG.TELEGRAM_TOKEN}/editMessageText`;
  const proveedores = getProveedores();

  // Crear botones en grupos de 3 por fila
  const botones = [];
  for (let i = 0; i < proveedores.length; i += 3) {
    const fila = [];
    for (let j = 0; j < 3 && (i + j) < proveedores.length; j++) {
      const proveedor = proveedores[i + j];
      fila.push({
        text: proveedor,
        callback_data: `pagar:${proveedor}:${monto}:${username}`
      });
    }
    botones.push(fila);
  }

  // Botón de regreso
  botones.push([{
    text: '⬅️ Volver',
    callback_data: `proveedor:${monto}:${username}`
  }]);

  const keyboard = {
    inline_keyboard: botones
  };

  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'HTML',
    reply_markup: keyboard
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  UrlFetchApp.fetch(url, options);
}

// ========================================
// MOSTRAR OPCIONES DE PAGO (GASTOS) - ACTUALIZADO
// ========================================
function mostrarOpcionesPago(chatId, messageId, monto, username) {
  const url = `${CONFIG.TELEGRAM_API_BASE}/bot${CONFIG.TELEGRAM_TOKEN}/editMessageText`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '💸 Gasto personal', callback_data: `tipopago:${TIPOS_PAGO.GASTO}:${monto}:${username}` }],
      [{ text: '📦 Mercadería', callback_data: `tipopago:${TIPOS_PAGO.MERCADERIA}:${monto}:${username}` }],
      [{ text: '🗑️ Desperdicio', callback_data: `tipopago:${TIPOS_PAGO.DESPERDICIO}:${monto}:${username}` }]
    ]
  };

  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: '💸 Tipo de gasto:',
    parse_mode: 'HTML',
    reply_markup: keyboard
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  UrlFetchApp.fetch(url, options);
}

// ========================================
// RESPONDER A CALLBACK (EVITA "LOADING...")
// ========================================
function answerCallback(callbackId) {
  const url = `${CONFIG.TELEGRAM_API_BASE}/bot${CONFIG.TELEGRAM_TOKEN}/answerCallbackQuery`;

  const payload = {
    callback_query_id: callbackId
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  UrlFetchApp.fetch(url, options);
}