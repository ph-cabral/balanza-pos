// ========================================
// CONFIGURACIÓN GLOBAL
// ========================================
const CONFIG = {
  // Telegram
  TELEGRAM_TOKEN: "7215963245:AAEDG4bAlDPXrZQQHMYO6J5EwufM9YEvd00",
  TELEGRAM_API_BASE: "https://api.telegram.org",
  WEBAPP_URL:
    "https://script.google.com/macros/s/AKfycbxqesFQpEmKXpWbrGYXXjNP-zALbSvxz_WFSYNI65XvRkTO54S-0Vwx8OcqxIGl0fqH/exec",

  // Google Sheets
  SHEET_ID: "15eZpBLQVGjY54vA_07kauFhhu2a7ocEXF6jQ-d-hHf4",
  PROVEEDORES_SHEET_NAME: "proveedores",
  TIMEZONE: "America/Argentina/Buenos_Aires",

  // Mammouth (OCR de facturas)
  MAMMOUTH_KEY: "sk-RlVcd08wjzh91Hmt9rNgcA",
  MAMMOUTH_API_URL: "https://api.mammouth.ai/v1/chat/completions",
  MAMMOUTH_MODEL: "gpt-4.1-nano",

  // Reglas de negocio
  GANANCIA_PORCENTAJE: 0.2,
  FACTOR_MERCADERIA_DESPERDICIO: 0.75,
};

// Semilla: solo se usa UNA vez, para poblar la pestaña "proveedores"
// la primera vez que se crea. Una vez creada, la lista real se edita
// directamente en la hoja de cálculo (pestaña "proveedores"), no acá.
const PROVEEDORES_SEED = [
  "Amiplast",
  "Anselmi",
  "Bachilito",
  "Cafaratti(pepsi)",
  "Carbon",
  "Barraza",
  "Coca",
  "Disbe",
  "Dutto",
  "DP(Paladini)",
  "Empanadas",
  "Esperanza",
  "Fernando_Cavallo",
  "Glass",
  "GrupoM",
  "Huevos",
  "L&L(Secco)",
  "La_Bri",
  "Las_Cañitas",
  "Marzal",
  "Milanesas",
  "Moni(chocol/ensala)",
  "Nono_Fidel",
  "Panaderia_Argentina",
  "Panero",
  "Pauletto_rey",
  "Piamontesa",
  "Pizza_Juan",
  "Placeres_Naturales",
  "Region_Centro",
  "Veneziana",
  "Verduleria",
  "Otro",
];

// Tipos de pago
const TIPOS_PAGO = {
  GASTO: "gasto_personal",
  MERCADERIA: "mercaderia",
  DESPERDICIO: "desperdicio",
};
