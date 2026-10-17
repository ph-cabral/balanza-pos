// ===============================
// DESCARGAR ARCHIVO DESDE TELEGRAM
// ===============================
function descargarArchivoTelegram(fileId) {
  const urlInfo = `${CONFIG.TELEGRAM_API_BASE}/bot${CONFIG.TELEGRAM_TOKEN}/getFile?file_id=${fileId}`;
  const response = UrlFetchApp.fetch(urlInfo);
  const info = JSON.parse(response.getContentText());

  const filePath = info.result.file_path;
  const fileUrl = `${CONFIG.TELEGRAM_API_BASE}/file/bot${CONFIG.TELEGRAM_TOKEN}/${filePath}`;

  const fileBlob = UrlFetchApp.fetch(fileUrl).getBlob();
  fileBlob.setName("factura.jpg");

  return fileBlob;
}

// ===============================
// ANALIZAR IMAGEN CON OPENAI (MAMMOUTH)
// ===============================
function analizarImagenOpenAI(imagenBlob) {
  const apiKey = CONFIG.MAMMOUTH_KEY;
  const url = CONFIG.MAMMOUTH_API_URL;

  const base64img = Utilities.base64Encode(imagenBlob.getBytes());
  const imgTag = "data:image/jpeg;base64," + base64img;

  const payload = {
    model: CONFIG.MAMMOUTH_MODEL,
    messages: [
      {
        role: "system",
        content:
          "Extract supplier name, total amount, and product items. Respond ONLY in JSON: {\"proveedor\":\"\",\"total\":0,\"items\":[{\"producto\":\"\",\"cantidad\":0}]}"
      },
      {
        role: "user",
        content: "Analyze the following invoice:\n\n<image:" + imgTag + ">"
      }
    ]
  };

  const options = {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + apiKey },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const txt = response.getContentText();

  Logger.log("📥 Mammouth RAW: " + txt);

  const json = JSON.parse(txt);

  // Capturar error textual si existe
  if (json.error) {
    throw new Error("Mammouth error: " + JSON.stringify(json.error));
  }

  const content =
    json.choices?.[0]?.message?.content ||
    json.choices?.[0]?.delta?.content;

  if (!content) {
    throw new Error("Mammouth no devolvió 'content'. Respuesta: " + txt);
  }

  return JSON.parse(content);
}

// ===============================
// PROCESAR FOTO DE FACTURA
// ===============================
function procesarImagenFactura(chatId, fileId) {
  try {
    sendMessage(chatId, "🧠 Procesando imagen, un momento...");

    const imagenBlob = descargarArchivoTelegram(fileId);
    const data = analizarImagenOpenAI(imagenBlob);

    const proveedor = data.proveedor || "Desconocido";
    const monto = Math.abs(data.total || 0);

    const sheet = getOrCreateSheet();

    const ahora = new Date();
    const fecha = Utilities.formatDate(ahora, CONFIG.TIMEZONE, "yyyy-MM-dd");
    const hora = Utilities.formatDate(ahora, CONFIG.TIMEZONE, "HH:mm");

    // Registrar como PROVEEDOR (gasto → monto negativo)
    sheet.appendRow([fecha, hora, proveedor, -monto, true]);
    invalidarCacheTotales_();

    const totales = calcularTotales();

    let respuesta = "📸 Factura procesada\n\n";
    respuesta += `🏭 Proveedor: <b>${proveedor}</b>\n`;
    respuesta += `💰 Total: $${formatearNumero(monto)}\n\n`;

    if (data.items && data.items.length > 0) {
      respuesta += "📦 Productos:\n";
      data.items.forEach(item => {
        respuesta += `• ${item.producto} x${item.cantidad}\n`;
      });
      respuesta += "\n";
    }

    respuesta += `💰 Ingreso día: $${formatearNumero(totales.totalDia)}\n`;
    respuesta += `📅 Ingreso mes: $${formatearNumero(totales.totalMes)}\n`;
    respuesta += `📊 Ganancia estimada: $${formatearNumero(totales.gananciaEstimada)}`;

    sendMessage(chatId, respuesta);

  } catch (err) {
    sendMessage(chatId, "❌ Error procesando la imagen.\n\n" + err);
    Logger.log("❌ ERROR COMPLETO procesando factura: " + JSON.stringify(err, null, 2));
  }
}
