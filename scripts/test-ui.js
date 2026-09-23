'use strict';

/**
 * Prueba de la interfaz con un navegador real: recorre grupo -> producto ->
 * carrito, verifica que la pantalla vuelva sola a los grupos, prueba el
 * reordenamiento por arrastre, el swipe para eliminar y el cierre de venta.
 * Deja capturas de pantalla en la carpeta capturas/.
 *
 *   node scripts/test-ui.js
 *
 * Los pasos que dependen de un peso se saltean solos si la balanza no esta en
 * modo simulador (con la balanza real apoyada en cero no hay nada que capturar).
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
// Playwright se resuelve desde los modulos globales (no es dependencia del proyecto).
const RUTA_PW = process.env.PW ||
  path.join(execSync('npm root -g').toString().trim(), 'playwright');
const { chromium } = require(RUTA_PW);

const RAIZ = path.join(__dirname, '..');
const SALIDA = path.join(RAIZ, 'capturas');
const URL = 'http://localhost:3000';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Chromium propio si hay uno a mano; si no, el que trae Playwright.
const CHROME = process.env.PW_CHROME ||
  ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => fs.existsSync(p));

let fallos = 0;
function chequear(desc, cond, detalle) {
  if (!cond) fallos++;
  console.log(`  ${cond ? 'OK  ' : 'MAL '} ${desc}${detalle ? '  -> ' + detalle : ''}`);
}

(async function main() {
  if (!fs.existsSync(SALIDA)) fs.mkdirSync(SALIDA, { recursive: true });

  const servidor = spawn(process.execPath, [path.join(RAIZ, 'src', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    // Las ventas de prueba no se copian a la planilla real de Google Sheets.
    env: { ...process.env, POS_SIN_SHEETS: '1' },
  });
  const terminar = (c) => { try { servidor.kill(); } catch (_) {} process.exit(c); };

  for (let i = 0; i < 40; i++) {
    try { await fetch(URL + '/api/balanza'); break; } catch (_) { await esperar(200); }
  }

  // Con la balanza real no se pueden simular pesos: esos pasos se saltean.
  let conSimulador = false;
  try {
    const cfg = await (await fetch(URL + '/api/config')).json();
    conSimulador = !!(cfg.ok && cfg.config.balanza.simulador);
  } catch (_) { /* si no responde, falla mas abajo con mejor mensaje */ }

  const navegador = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const ctx = await navegador.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  const pagina = await ctx.newPage();

  const errores = [];
  pagina.on('pageerror', (e) => errores.push(e.message));
  pagina.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });

  /** Espera a que la pantalla vuelva sola a los grupos. */
  const esperarGrupos = () => pagina.waitForFunction(
    () => !document.querySelector('#vistaGrupos').hasAttribute('hidden'),
    { timeout: 10000 }
  );

  /** Espera a que la balanza quede estable en un peso concreto ("0,250"). */
  const estableEn = (kg) => pagina.waitForFunction(
    (k) => document.querySelector('#chipTexto').textContent.indexOf('estable') !== -1 &&
           document.querySelector('#pesoNumero').textContent === k,
    kg, { timeout: 8000 }
  );

  try {
    console.log('\n1. La pantalla arranca en los grupos');
    await pagina.goto(URL, { waitUntil: 'networkidle' });
    await esperar(800);
    // Con varias estaciones el equipo pregunta en cual trabaja: la primera.
    if (await pagina.locator('#selectorEstacion').isVisible()) {
      await pagina.locator('.selector-opcion').first().click();
      await esperar(600);
      console.log('       (había varias estaciones: se eligió la primera)');
    }

    const grupos = await pagina.locator('.grupo').count();
    chequear('muestra los grupos', grupos > 0, grupos + ' grupos');
    chequear('los grupos son la pantalla base', await pagina.locator('#vistaGrupos').isVisible());
    chequear('no muestra productos todavía', !(await pagina.locator('#vistaProductos').isVisible()));
    chequear('muestra el panel de peso', await pagina.locator('#pesoNumero').isVisible());
    chequear('el botón de cobrar arranca deshabilitado', await pagina.locator('#btnCobrar').isDisabled());
    await pagina.screenshot({ path: path.join(SALIDA, '1-grupos.png') });

    console.log('\n2. Entrar a un grupo y volver');
    await pagina.locator('.grupo', { hasText: 'Quesos' }).first().click();
    await esperar(400);
    chequear('abre los productos del grupo', await pagina.locator('#vistaProductos').isVisible());
    chequear('el título es el del grupo',
      (await pagina.locator('#tituloGrupo').textContent()).indexOf('Quesos') !== -1);
    const enQuesos = await pagina.locator('.prod').count();
    chequear('lista solo los productos del grupo', enQuesos > 0 && enQuesos < 16, enQuesos + ' productos');
    await pagina.screenshot({ path: path.join(SALIDA, '2-productos-del-grupo.png') });

    await pagina.locator('#btnVolver').click();
    await esperar(300);
    chequear('el botón volver regresa a los grupos', await pagina.locator('#vistaGrupos').isVisible());

    console.log('\n3. Acomodar los grupos arrastrando');
    const ordenAntes = await pagina.locator('.grupo-nombre').allTextContents();
    await pagina.locator('#btnOrdenar').click();
    await esperar(200);
    const a = await pagina.locator('.grupo').nth(0).boundingBox();
    const b = await pagina.locator('.grupo').nth(2).boundingBox();
    await pagina.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await pagina.mouse.down();
    await pagina.mouse.move(b.x + b.width * 0.75, b.y + b.height / 2, { steps: 16 });
    await pagina.mouse.up();
    await esperar(600);
    const ordenDespues = await pagina.locator('.grupo-nombre').allTextContents();
    chequear('el arrastre cambia el orden en pantalla',
      ordenAntes.join() !== ordenDespues.join(), ordenDespues.join(' · '));
    await pagina.locator('#btnOrdenar').click();   // "Listo"

    await pagina.reload({ waitUntil: 'networkidle' });
    await esperar(700);
    const ordenGuardado = await pagina.locator('.grupo-nombre').allTextContents();
    chequear('el orden queda guardado en el servidor',
      ordenGuardado.join() === ordenDespues.join(), ordenGuardado.join(' · '));

    // Lo dejamos como estaba, para no ensuciar la configuración real.
    await pagina.evaluate(async (nombres) => {
      const r = await fetch('/api/categorias').then((x) => x.json());
      const ids = nombres.map((n) => (r.categorias.find((c) => c.nombre === n) || {}).id).filter(Boolean);
      await fetch('/api/categorias/orden', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids }),
      });
    }, ordenAntes);
    await pagina.reload({ waitUntil: 'networkidle' });
    await esperar(600);
    chequear('se restaura el orden original',
      (await pagina.locator('.grupo-nombre').allTextContents()).join() === ordenAntes.join());

    if (conSimulador) {
      console.log('\n4. Peso: apoyar 250 g y cargar un producto por peso');
      await pagina.locator('[data-sim="250"]').click();
      await estableEn('0,250');
      chequear('la balanza llega a peso estable', true, await pagina.locator('#pesoNumero').textContent() + ' kg');

      await pagina.locator('.grupo', { hasText: 'Jamones' }).first().click();
      await esperar(300);
      await pagina.locator('.prod', { hasText: 'Jamón cocido' }).first().click();
      await esperar(600);

      chequear('muestra el carrito en pantalla', await pagina.locator('#vistaConfirma').isVisible());
      chequear('agrega el producto pesado al carrito', await pagina.locator('.item').count() === 1);

      const detalle = await pagina.locator('.item-detalle').first().textContent();
      chequear('muestra kg × precio por kg', /0,250 kg/.test(detalle), detalle);

      // Jamon cocido: $12.500/kg x 0,250 kg = $3.125
      const sub = await pagina.locator('.item-subtotal').first().textContent();
      chequear('calcula bien el subtotal', sub.replace(/\s/g, '').indexOf('3.125,00') !== -1, sub);
      await pagina.screenshot({ path: path.join(SALIDA, '3-carrito-en-pantalla.png') });

      await esperarGrupos();
      chequear('la pantalla vuelve sola a los grupos', await pagina.locator('#vistaGrupos').isVisible());

      console.log('\n5. Tara y segundo producto');
      await pagina.locator('[data-sim="0"]').click();
      await estableEn('0,000');
      await pagina.locator('[data-sim="500"]').click();
      await estableEn('0,500');
      await pagina.locator('.grupo', { hasText: 'Quesos' }).first().click();
      await esperar(300);
      await pagina.locator('.prod', { hasText: 'Queso cremoso' }).first().click();
      await esperar(600);
      chequear('el carrito tiene dos artículos', await pagina.locator('.item').count() === 2);

      // Queso cremoso: $9.800/kg x 0,500 kg = $4.900  -> total $8.025
      const total1 = await pagina.locator('#total').textContent();
      chequear('el total suma los dos', total1.replace(/\s/g, '').indexOf('8.025,00') !== -1, total1);
      await esperarGrupos();
    } else {
      console.log('\n4-5. (salteado: la balanza no está en modo simulador)');
    }

    console.log('\n6. Escáner: producto por unidad');
    const antesDelScan = await pagina.locator('.item').count();
    await pagina.evaluate(() => {
      // Simula la ráfaga de teclas de un lector USB.
      const codigo = '7790895000997';
      for (const ch of codigo) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await esperar(700);
    chequear('el escáner agrega el artículo', await pagina.locator('.item').count() === antesDelScan + 1);
    chequear('el escáner también muestra el carrito', await pagina.locator('#vistaConfirma').isVisible());

    const ctrl = await pagina.locator('.cant-ctrl').count();
    chequear('el artículo por unidad tiene control de cantidad', ctrl === 1);

    await pagina.locator('.cant-btn').last().click();
    await esperar(300);
    const cant = await pagina.locator('.cant-valor').first().textContent();
    chequear('el botón + suma una unidad', cant === '2', cant + ' unidades');

    chequear('tocar la pantalla corta la vuelta automática',
      (await pagina.locator('#btnSeguir').textContent()).indexOf('Volver') !== -1);

    await pagina.screenshot({ path: path.join(SALIDA, '4-carrito-completo.png') });
    await pagina.locator('#btnSeguir').click();
    await esperar(300);
    chequear('el botón Seguir vuelve a los grupos', await pagina.locator('#vistaGrupos').isVisible());

    console.log('\n7. Deslizar para eliminar');
    const antes = await pagina.locator('.item').count();
    const caja = await pagina.locator('.item').first().boundingBox();
    await pagina.mouse.move(caja.x + caja.width / 2, caja.y + caja.height / 2);
    await pagina.mouse.down();
    await pagina.mouse.move(caja.x + caja.width / 2 - 180, caja.y + caja.height / 2, { steps: 12 });
    await pagina.mouse.up();
    await esperar(600);
    const despues = await pagina.locator('.item').count();
    chequear('el swipe elimina el artículo', despues === antes - 1, `${antes} -> ${despues}`);

    console.log('\n8. Cerrar la venta');
    const totalFinal = await pagina.locator('#total').textContent();
    await pagina.locator('#btnCobrar').click();
    await esperar(1200);

    chequear('el carrito queda vacío', await pagina.locator('.item').count() === 0);
    chequear('vuelve a mostrar el mensaje inicial', await pagina.locator('.carrito-vacio').isVisible());
    chequear('el total vuelve a cero', (await pagina.locator('#total').textContent()).indexOf('0,00') !== -1);
    chequear('la pantalla queda en los grupos', await pagina.locator('#vistaGrupos').isVisible());
    chequear('avisa que la venta se guardó', (await pagina.locator('.aviso').first().textContent()).indexOf('guardada') !== -1);
    console.log(`       (venta cerrada por ${totalFinal.trim()})`);

    await pagina.screenshot({ path: path.join(SALIDA, '5-venta-cerrada.png') });

    console.log('\n9. Búsqueda');
    await pagina.locator('#buscador').fill('queso');
    await esperar(400);
    chequear('la búsqueda muestra resultados de todos los grupos',
      await pagina.locator('.prod').count() > 0);
    await pagina.locator('#btnLimpiarBusqueda').click();
    await esperar(300);
    chequear('limpiar la búsqueda vuelve a los grupos', await pagina.locator('#vistaGrupos').isVisible());

    console.log('\n10. Pantalla de administración');
    await pagina.goto(URL + '/admin.html', { waitUntil: 'networkidle' });
    await esperar(700);
    chequear('la pestaña de grupos carga', await pagina.locator('.fila-grupo').count() > 0);
    await pagina.screenshot({ path: path.join(SALIDA, '6-admin-grupos.png'), fullPage: true });

    await pagina.locator('.tab', { hasText: 'Productos' }).click();
    await esperar(500);
    chequear('la tabla de productos carga', await pagina.locator('#tablaProductos tr').count() > 0);
    chequear('el alta de producto elige el grupo de una lista',
      await pagina.locator('#prodCategoria option').count() > 0);
    await pagina.screenshot({ path: path.join(SALIDA, '7-admin-productos.png'), fullPage: true });

    await pagina.locator('.tab', { hasText: 'Estaciones' }).click();
    await esperar(1200);
    chequear('la pestaña Estaciones lista las estaciones', await pagina.locator('.fila-estacion').count() > 0);
    chequear('y las balanzas', await pagina.locator('#listaBalanzas .equipo').count() > 0);
    chequear('el diagnóstico de balanza muestra datos', (await pagina.locator('#dgPeso').textContent()) !== '—');
    chequear('sin cambios no se puede guardar', await pagina.locator('#btnGuardarEquipos').isDisabled());
    await pagina.screenshot({ path: path.join(SALIDA, '7b-admin-estaciones.png'), fullPage: true });

    await pagina.locator('.tab', { hasText: 'Ventas' }).click();
    await esperar(800);
    const filasVentas = await pagina.locator('#tablaVentas tr').count();
    chequear('la venta cerrada aparece en el historial', filasVentas > 0, filasVentas + ' fila(s)');
    await pagina.screenshot({ path: path.join(SALIDA, '8-admin-ventas.png'), fullPage: true });

    console.log('\n11. Vista vertical (tablet parada)');
    await pagina.setViewportSize({ width: 820, height: 1180 });
    await pagina.goto(URL, { waitUntil: 'networkidle' });
    await esperar(800);
    await pagina.screenshot({ path: path.join(SALIDA, '9-vertical.png') });
    chequear('la vista vertical no rompe el layout', await pagina.locator('#btnCobrar').isVisible());
    chequear('los grupos se ven en vertical', await pagina.locator('.grupo').first().isVisible());

    console.log('\n12. Celular: el carrito es una hoja que sube y baja');
    await pagina.setViewportSize({ width: 360, height: 740 });
    await pagina.goto(URL, { waitUntil: 'networkidle' });
    await esperar(800);
    const arribaHoja = async () => (await pagina.locator('#hoja').boundingBox()).y;
    const cerradaY = await arribaHoja();
    chequear('la hoja arranca escondida abajo', cerradaY > 740 * 0.8, Math.round(cerradaY) + ' px');

    const asa = await pagina.locator('#hojaAsa').boundingBox();
    await pagina.mouse.move(asa.x + asa.width / 2, asa.y + 8);
    await pagina.mouse.down();
    for (let y = asa.y + 8; y > asa.y - 400; y -= 40) {
      await pagina.mouse.move(asa.x + asa.width / 2, y);
      await esperar(16);
    }
    await pagina.mouse.up();
    await esperar(500);
    chequear('arrastrando la manija hacia arriba se abre', (await arribaHoja()) < 740 * 0.3);
    await pagina.screenshot({ path: path.join(SALIDA, '10-celular-hoja.png') });
    await pagina.mouse.click(180, 30);
    await esperar(500);
    chequear('tocando afuera se vuelve a esconder', Math.abs((await arribaHoja()) - cerradaY) < 2);

    if (conSimulador) {
      await fetch(URL + '/api/balanza/simular', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gramos: 300 }),
      });
      await esperar(1500);
      await pagina.locator('.grupo').first().click();
      await esperar(300);
      await pagina.locator('.prod').first().click();
      await esperar(700);
      chequear('al agregar un artículo la hoja sube sola', (await arribaHoja()) < 740 * 0.3);
      chequear('detrás quedan los grupos', await pagina.locator('#vistaGrupos').isVisible());
      await esperar(5800);
      chequear('a los pocos segundos baja sola', Math.abs((await arribaHoja()) - cerradaY) < 2);
    }

    chequear('no hubo errores de JavaScript', errores.length === 0, errores.join(' | ') || 'ninguno');

  } catch (e) {
    console.error('\nError en la prueba de UI:', e.message);
    fallos++;
  }

  await navegador.close();

  console.log('\n---------------------------------------------');
  console.log(fallos === 0 ? '  Todo OK.' : `  ${fallos} verificacion(es) fallaron.`);
  console.log(`  Capturas en: ${SALIDA}`);
  console.log('---------------------------------------------\n');
  terminar(fallos === 0 ? 0 : 1);
})();
