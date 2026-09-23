'use strict';

/**
 * Prueba de humo de los grupos: migracion, endpoints y reordenamiento.
 * No toca la balanza (usa un doble) ni el puerto serie.
 *
 *   node scripts/test-grupos.js
 */

const express = require('express');
const crearApi = require('../src/routes/api');
const db = require('../src/db');

const balanzaFalsa = {
  snapshot: () => ({ conectado: false, gramos: 0, estable: false }),
  capturar: () => ({ ok: true, gramos: 235 }),
  tramasCrudas: () => [],
  simularPeso: () => false,
  reconfigurar: () => {},
};

const app = express();
app.use(express.json());
app.use('/api', crearApi({
  balanza: balanzaFalsa,
  guardarConfig: () => {},
  config: { balanza: {}, venta: {} },
}));

const server = app.listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const pedir = async (ruta, opciones) => {
    const r = await fetch(base + ruta, opciones);
    return { estado: r.status, cuerpo: await r.json() };
  };
  const json = (metodo, cuerpo) => ({
    method: metodo,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });

  let fallas = 0;
  const chequear = (titulo, condicion, detalle) => {
    console.log((condicion ? '  ok   ' : '  FALLA') + '  ' + titulo + (condicion ? '' : '  -> ' + detalle));
    if (!condicion) fallas++;
  };

  // 1. Listado de grupos
  let r = await pedir('/api/categorias');
  const grupos = r.cuerpo.categorias;
  chequear('lista los grupos activos', grupos.length >= 7, JSON.stringify(r.cuerpo));
  chequear('vienen en orden', grupos.every((g, i) => i === 0 || grupos[i - 1].orden <= g.orden), '');

  // 2. Reordenar: el ultimo pasa a ser el primero
  const ids = grupos.map((g) => g.id);
  const nuevos = [ids[ids.length - 1], ...ids.slice(0, -1)];
  r = await pedir('/api/categorias/orden', json('PUT', { ids: nuevos }));
  chequear('guarda el orden nuevo', r.cuerpo.ok === true, JSON.stringify(r.cuerpo));

  r = await pedir('/api/categorias');
  chequear('el orden quedo guardado',
    r.cuerpo.categorias.map((g) => g.id).join() === nuevos.join(),
    r.cuerpo.categorias.map((g) => g.nombre).join());

  // Lo dejamos como estaba
  await pedir('/api/categorias/orden', json('PUT', { ids }));
  r = await pedir('/api/categorias');
  chequear('vuelve al orden original', r.cuerpo.categorias.map((g) => g.id).join() === ids.join(), '');

  // 3. Alta, renombrado y baja
  r = await pedir('/api/categorias', json('POST', { nombre: 'Prueba ' + Date.now() }));
  chequear('crea un grupo', r.cuerpo.ok === true, JSON.stringify(r.cuerpo));
  const nuevo = r.cuerpo.categoria;
  chequear('el grupo nuevo va al final', nuevo.orden > grupos[grupos.length - 1].orden, String(nuevo.orden));

  r = await pedir('/api/categorias', json('POST', { nombre: nuevo.nombre }));
  chequear('no deja repetir el nombre', r.estado === 400, JSON.stringify(r.cuerpo));

  // 4. Un producto en ese grupo, y renombrado del grupo
  r = await pedir('/api/productos', json('POST', {
    nombre: 'Producto de prueba', categoria_id: nuevo.id, tipo: 'peso', precio_centavos: 100000,
  }));
  chequear('crea un producto en el grupo', r.cuerpo.ok === true, JSON.stringify(r.cuerpo));
  const prod = r.cuerpo.producto;
  chequear('el producto copia el nombre del grupo', prod.categoria === nuevo.nombre, prod.categoria);

  r = await pedir('/api/categorias/' + nuevo.id, json('PUT', { nombre: 'Prueba renombrada' }));
  chequear('renombra el grupo', r.cuerpo.ok === true, JSON.stringify(r.cuerpo));
  const luego = db.productoPorId(prod.id);
  chequear('el renombre llega al producto', luego.categoria === 'Prueba renombrada', luego.categoria);

  // 5. Importacion por nombre de grupo
  r = await pedir('/api/productos/importar', json('POST', {
    productos: [{ nombre: 'Importado de prueba', marca: 'MarcaNueva', categoria: 'Grupo Importado', tipo: 'unidad', precio_centavos: 50000 }],
  }));
  chequear('importa creando el grupo', r.cuerpo.creados === 1, JSON.stringify(r.cuerpo));
  r = await pedir('/api/categorias');
  chequear('el grupo importado aparece',
    r.cuerpo.categorias.some((g) => g.nombre === 'Grupo Importado'), '');

  // 6. Limpieza: se borran las pruebas de la base
  const importado = db.listarProductos().find((p) => p.nombre === 'Importado de prueba');
  db.db.prepare('DELETE FROM productos WHERE id IN (?, ?)').run(prod.id, importado ? importado.id : -1);
  db.db.prepare("DELETE FROM categorias WHERE nombre IN ('Prueba renombrada','Grupo Importado')").run();
  db.db.prepare("DELETE FROM marcas WHERE nombre = 'MarcaNueva'").run();

  r = await pedir('/api/categorias');
  chequear('la base queda como estaba', r.cuerpo.categorias.length === grupos.length, String(r.cuerpo.categorias.length));

  console.log('');
  console.log(fallas ? '  ' + fallas + ' falla(s)' : '  todo bien');
  server.close();
  process.exit(fallas ? 1 : 0);
});
