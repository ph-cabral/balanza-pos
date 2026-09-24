'use strict';

/**
 * Prueba de humo: levanta el servidor, simula pesos, arma una venta y verifica
 * que las cuentas cierren. Sirve para confirmar que todo funciona antes de
 * tener la balanza conectada.
 *
 *   node scripts/test-humo.js
 */

const { spawn } = require('child_process');
const path = require('path');

const BASE = 'http://localhost:3000/api';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let fallos = 0;
function chequear(descripcion, condicion, detalle) {
  const marca = condicion ? 'OK  ' : 'MAL ';
  if (!condicion) fallos++;
  console.log(`  ${marca} ${descripcion}${detalle ? '  -> ' + detalle : ''}`);
}

async function get(ruta) {
  const r = await fetch(BASE + ruta);
  return r.json();
}

async function post(ruta, cuerpo) {
  const r = await fetch(BASE + ruta, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo || {}),
  });
  return r.json();
}

async function esperarEstable(intentos = 25) {
  for (let i = 0; i < intentos; i++) {
    const d = await get('/balanza');
    if (d.balanza.estable) return d.balanza;
    await esperar(120);
  }
  return null;
}

(async function main() {
  const servidor = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    // Las ventas de prueba no se copian a la planilla real de Google Sheets.
    env: { ...process.env, POS_SIN_SHEETS: '1' },
  });

  const terminar = (codigo) => { try { servidor.kill(); } catch (_) {} process.exit(codigo); };

  try {
    // Esperamos a que levante el HTTP.
    for (let i = 0; i < 40; i++) {
      try { await fetch(BASE + '/balanza'); break; } catch (_) { await esperar(200); }
    }

    console.log('\n1. Catalogo');
    const cat = await get('/productos');
    chequear('devuelve productos', cat.ok && cat.productos.length > 0, cat.productos && cat.productos.length + ' productos');
    const jamon = cat.productos.find((p) => p.tipo === 'peso');
    const gaseosa = cat.productos.find((p) => p.tipo === 'unidad' && p.codigo_barras);
    chequear('hay un producto por peso', !!jamon, jamon && jamon.nombre);
    chequear('hay un producto por unidad con codigo', !!gaseosa, gaseosa && gaseosa.nombre);

    console.log('\n2. Balanza: estabilizacion y captura');
    for (const g of [350, 0, 500, 1250]) {
      await post('/balanza/simular', { gramos: g });
      const b = await esperarEstable();
      chequear(
        `se estabiliza en ${g} g`,
        b !== null && b.gramos === g,
        b ? b.gramos + ' g' : 'nunca se estabilizo'
      );

      const cap = await post('/balanza/capturar');
      if (g === 0) {
        chequear('con la balanza vacia no deja capturar', !cap.ok, cap.error);
      } else {
        chequear(`captura ${g} g`, cap.ok && cap.gramos === g, JSON.stringify(cap));
      }
    }

    console.log('\n3. Escaner: busqueda por codigo de barras');
    const porCodigo = await get('/productos/codigo/' + gaseosa.codigo_barras);
    chequear('encuentra el producto por codigo', porCodigo.ok && porCodigo.producto.id === gaseosa.id);
    const inexistente = await get('/productos/codigo/0000000000000');
    chequear('codigo inexistente da error claro', !inexistente.ok, inexistente.error);

    console.log('\n4. Venta: 350 g por peso + 2 unidades');
    const venta = await post('/ventas', {
      items: [
        { producto_id: jamon.id, tipo: 'peso', cantidad: 350 },
        { producto_id: gaseosa.id, tipo: 'unidad', cantidad: 2 },
      ],
    });
    chequear('la venta se guarda', venta.ok, JSON.stringify(venta.venta || venta.error));

    const esperadoPeso = Math.round((350 * jamon.precio_centavos) / 1000);
    const esperadoUnidad = 2 * gaseosa.precio_centavos;
    const esperadoTotal = esperadoPeso + esperadoUnidad;
    chequear(
      'el total lo calcula bien el servidor',
      venta.ok && venta.venta.total_centavos === esperadoTotal,
      `esperado ${esperadoTotal} / obtenido ${venta.ok ? venta.venta.total_centavos : '-'}`
    );

    const detalle = await get('/ventas/' + venta.venta.id);
    chequear('el detalle guarda los dos items', detalle.ok && detalle.venta.items.length === 2);
    chequear(
      'guarda el peso en gramos',
      detalle.ok && detalle.venta.items[0].cantidad === 350,
      detalle.venta.items[0].cantidad + ' g'
    );

    console.log('\n5. Venta invalida');
    const vacia = await post('/ventas', { items: [] });
    chequear('rechaza una venta sin items', !vacia.ok, vacia.error);

    const negativa = await post('/ventas', {
      items: [{ producto_id: jamon.id, tipo: 'peso', cantidad: 0 }],
    });
    chequear('rechaza cantidad en cero', !negativa.ok, negativa.error);

    console.log('\n6. El servidor no confia en el precio del navegador');
    const manipulada = await post('/ventas', {
      items: [{ producto_id: jamon.id, tipo: 'peso', cantidad: 1000, precio_centavos: 1 }],
    });
    chequear(
      'ignora el precio mandado y usa el del catalogo',
      manipulada.ok && manipulada.venta.total_centavos === jamon.precio_centavos,
      `total ${manipulada.venta && manipulada.venta.total_centavos} (precio de lista ${jamon.precio_centavos})`
    );

    console.log('\n7. Resumen del dia');
    const resumen = await get('/ventas');
    chequear('cuenta las ventas del dia', resumen.ok && resumen.resumen.ventas >= 2, JSON.stringify(resumen.resumen));

    console.log('\n8. Totales por dia y por mes');
    const tot = await get('/ventas/totales');
    const hoyTot = tot.ok && tot.dias.find((x) => x.dia === tot.hoy);
    chequear('devuelve el mes en curso', tot.ok && tot.mes === tot.hoy.slice(0, 7), tot.mes);
    chequear('trae todos los dias del mes hasta hoy', tot.ok && tot.dias.length === Number(tot.hoy.slice(8, 10)), tot.dias && tot.dias.length + ' dias');
    chequear(
      'el total de hoy coincide con el resumen del dia',
      hoyTot && hoyTot.total_centavos === resumen.resumen.total_centavos && hoyTot.ventas === resumen.resumen.ventas,
      hoyTot && `${hoyTot.total_centavos} / ${resumen.resumen.total_centavos}`
    );
    const sumaDias = tot.ok ? tot.dias.reduce((a, x) => a + x.total_centavos, 0) : -1;
    const mesTot = tot.ok && tot.meses.find((m) => m.mes === tot.mes);
    chequear(
      'la suma de los dias da el total del mes',
      mesTot && sumaDias === tot.totalMes.total_centavos && sumaDias === mesTot.total_centavos,
      `${sumaDias} / ${tot.totalMes && tot.totalMes.total_centavos}`
    );
    const vacio = await get('/ventas/totales?mes=2001-02');
    chequear('mes sin ventas: 28 dias en cero', vacio.ok && vacio.dias.length === 28 && vacio.totalMes.total_centavos === 0);
    const malo = await get('/ventas/totales?mes=basura');
    chequear('mes invalido cae en el actual', malo.ok && malo.mes === tot.mes);

    console.log('\n---------------------------------------------');
    if (fallos === 0) {
      console.log('  Todo OK.');
      console.log('---------------------------------------------\n');
      terminar(0);
    } else {
      console.log(`  ${fallos} verificacion(es) fallaron.`);
      console.log('---------------------------------------------\n');
      terminar(1);
    }
  } catch (e) {
    console.error('\nError inesperado en la prueba:', e);
    terminar(1);
  }
})();
