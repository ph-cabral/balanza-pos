'use strict';

/**
 * Vacia las ventas de prueba antes de arrancar en serio: borra ventas,
 * venta_items, la cola de copia a Sheets y el registro de ventas importadas
 * de la planilla. No toca productos, marcas, categorias ni estaciones (eso
 * es catalogo real, no una prueba). Reinicia el autoincremental de ventas y
 * compacta el archivo con VACUUM.
 *
 * Opera sobre data/pos.db (o POS_DATA si esta seteado). Pide confirmacion
 * escrita salvo que se pase --si.
 *
 *   npm run limpiar-ventas
 *   npm run limpiar-ventas -- --si
 */

const readline = require('readline');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.POS_DATA || path.join(__dirname, '..', 'data');
const RUTA_DB = path.join(DATA_DIR, 'pos.db');

function confirmar(pregunta) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(pregunta, (r) => { rl.close(); resolve(r); }));
}

async function main() {
  const forzado = process.argv.includes('--si');
  const db = new Database(RUTA_DB);
  const cuantas = db.prepare('SELECT COUNT(*) AS n FROM ventas').get().n;

  console.log(`Base: ${RUTA_DB}`);
  console.log(`Ventas actuales: ${cuantas}`);

  if (!forzado) {
    const r = await confirmar('Esto borra TODAS las ventas (son de prueba) y no se puede deshacer. Escribir "si" para continuar: ');
    if (r.trim().toLowerCase() !== 'si') { console.log('Cancelado.'); db.close(); return; }
  }

  db.transaction(() => {
    db.exec('DELETE FROM venta_items');
    db.exec('DELETE FROM sheets_cola');
    db.exec('DELETE FROM sheets_importadas');
    db.exec('DELETE FROM ventas');
    try { db.exec(`DELETE FROM sqlite_sequence WHERE name IN ('ventas','venta_items')`); } catch (_) { /* sin autoincrement usado aun */ }
  })();

  db.exec('VACUUM');
  console.log('Listo: ventas, items, cola de Sheets y registro de importadas, vacios.');
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
