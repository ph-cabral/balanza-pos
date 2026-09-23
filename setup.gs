// ========================================
// CONFIGURAR WEBHOOK
// ========================================
function setWebhook() {
  const url = `${CONFIG.TELEGRAM_API_BASE}/bot${CONFIG.TELEGRAM_TOKEN}/setWebhook?url=${CONFIG.WEBAPP_URL}&drop_pending_updates=true`;
  
  const response = UrlFetchApp.fetch(url);
  const result = JSON.parse(response.getContentText());
  
  Logger.log('Resultado del webhook:');
  Logger.log(result);
  
  if (result.ok) {
    Logger.log('✅ Webhook configurado correctamente!');
  } else {
    Logger.log('❌ Error al configurar webhook');
  }
  
  return result;
}

// ========================================
// ELIMINAR WEBHOOK
// ========================================
function deleteWebhook() {
  const url = `${CONFIG.TELEGRAM_API_BASE}/bot${CONFIG.TELEGRAM_TOKEN}/deleteWebhook?drop_pending_updates=true`;
  const response = UrlFetchApp.fetch(url);
  Logger.log(response.getContentText());
}

// ========================================
// VERIFICAR WEBHOOK
// ========================================
function getWebhookInfo() {
  const url = `${CONFIG.TELEGRAM_API_BASE}/bot${CONFIG.TELEGRAM_TOKEN}/getWebhookInfo`;
  const response = UrlFetchApp.fetch(url);
  Logger.log(response.getContentText());
}
