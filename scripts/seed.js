'use strict';

/**
 * Carga productos de ejemplo para poder probar el circuito completo
 * antes de tener el catalogo real.
 *
 *   npm run seed
 */

const db = require('../src/db');

const EJEMPLOS = [
  // Fiambres (por peso), con los grupos de la pantalla de venta
  { nombre: 'Jamón cocido',      marca: 'Paladini',       categoria: 'Jamones', tipo: 'peso',   precio_centavos: 1250000 },
  { nombre: 'Jamón crudo',       marca: 'Paladini',       categoria: 'Jamones', tipo: 'peso',   precio_centavos: 2890000 },
  { nombre: 'Salame milán',      marca: 'Cagnoli',        categoria: 'Embutidos', tipo: 'peso',   precio_centavos: 1680000 },
  { nombre: 'Mortadela',         marca: 'Paladini',       categoria: 'Embutidos', tipo: 'peso',   precio_centavos: 780000 },
  { nombre: 'Bondiola',          marca: 'Cagnoli',        categoria: 'Otros fiambres', tipo: 'peso',   precio_centavos: 2450000 },
  { nombre: 'Lomito ahumado',    marca: 'Swift',          categoria: 'Otros fiambres', tipo: 'peso',   precio_centavos: 2100000 },

  // Quesos (por peso)
  { nombre: 'Queso cremoso',     marca: 'La Serenísima',  categoria: 'Quesos',   tipo: 'peso',   precio_centavos: 980000 },
  { nombre: 'Queso pategrás',    marca: 'La Serenísima',  categoria: 'Quesos',   tipo: 'peso',   precio_centavos: 1420000 },
  { nombre: 'Queso port salut',  marca: 'Sancor',         categoria: 'Quesos',   tipo: 'peso',   precio_centavos: 1180000 },
  { nombre: 'Queso sardo',       marca: 'Sancor',         categoria: 'Quesos',   tipo: 'peso',   precio_centavos: 1950000 },
  { nombre: 'Queso roquefort',   marca: 'Santa Rosa',     categoria: 'Quesos',   tipo: 'peso',   precio_centavos: 2380000 },
  { nombre: 'Muzzarella',        marca: 'La Paulina',     categoria: 'Quesos',   tipo: 'peso',   precio_centavos: 1090000 },

  // Almacen (por unidad, con codigo de barras para probar el escaner)
  { nombre: 'Gaseosa 500 ml',    marca: 'Coca Cola',      categoria: 'Gaseosas',  tipo: 'unidad', precio_centavos: 150000, codigo_barras: '7790895000997' },
  { nombre: 'Agua mineral 1.5L', marca: 'Villa del Sur',  categoria: 'Gaseosas',  tipo: 'unidad', precio_centavos: 120000, codigo_barras: '7790520000019' },
  { nombre: 'Pan de mesa',       marca: 'Bimbo',          categoria: 'Almacén',  tipo: 'unidad', precio_centavos: 320000, codigo_barras: '7790040000015' },
  { nombre: 'Aceitunas 200 g',   marca: 'Nucete',         categoria: 'Almacén',  tipo: 'unidad', precio_centavos: 280000, codigo_barras: '7791234000017' },
];

const existentes = db.listarTodosLosProductos();
if (existentes.length) {
  console.log(`\nYa hay ${existentes.length} producto(s) cargados. No se hace nada.`);
  console.log('Si querés empezar de cero, borrá el archivo data/pos.db y volvé a correr esto.\n');
  process.exit(0);
}

const creados = db.importarProductos(EJEMPLOS);
console.log(`\n${creados} productos de ejemplo cargados.`);
console.log('Arrancá con:  npm start\n');
