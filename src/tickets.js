const D = require("better-sqlite3");
const db = new D("data/pos.db", { readonly: true });
const desde = process.argv[2] || new Date().toISOString().slice(0, 10);
const filas = db
  .prepare(
    `
  SELECT v.id, v.fecha, v.total_centavos AS total, v.descuento_nombre AS desc, v.descuento_centavos AS desc_c,
         i.nombre, i.marca, i.tipo, i.cantidad, i.precio_centavos AS precio, i.subtotal_centavos AS subtotal
  FROM ventas v JOIN venta_items i ON i.venta_id = v.id
  WHERE v.fecha >= ? AND v.origen = 'pos'
  ORDER BY v.fecha, v.id, i.id`,
  )
  .all(desde);
console.log(JSON.stringify(filas));
