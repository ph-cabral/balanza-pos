'use strict';

/**
 * Prueba de la simulacion de picada con un navegador real:
 * deslizar a la izquierda entra, merma en $ por kg, cantidades y $ de cada
 * fiambre, total, la venta abierta no se toca, deslizar a la derecha vuelve,
 * "Nueva picada" y el boton en celular.
 *
 *   node scripts/test-picada.js     (balanza en modo simulador, puerto 3000)
 */

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const RUTA_PW = process.env.PW ||
  path.join(execSync('npm root -g').toString().trim(), 'playwright');
const { chromium } = require(RUTA_PW);

const RAIZ = path.join(__dirname, '..');
const SALIDA = path.join(RAIZ, 'capturas');
const URL = 'http://localhost:3000';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
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
    env: { ...process.env, POS_SIN_SHEETS: '1' },
  });
  const terminar = (c) => { try { servidor.kill(); } catch (_) {} process.exit(c); };
  for (let i = 0; i < 40; i++) {
    try { await fetch(URL + '/api/balanza'); break; } catch (_) { await esperar(200); }
  }
  const cfg = await (await fetch(URL + '/api/config')).json();
  if (!(cfg.ok && cfg.config.balanza && cfg.config.balanza.simulador)) {
    console.log('La balanza no está en modo simulador: esta prueba necesita pesos simulados.');
    terminar(0);
  }

  const navegador = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const ctx = await navegador.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  const pagina = await ctx.newPage();
  // PW_LENTO=6 frena la CPU del navegador (x6) para reproducir la lentitud de CI.
  if (process.env.PW_LENTO) {
    const lento = await ctx.newCDPSession(pagina);
    await lento.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.PW_LENTO) });
  }
  const errores = [];
  pagina.on('pageerror', (e) => errores.push(e.message));
  pagina.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });

  const texto = (sel) => pagina.locator(sel).innerText();
  const simular = (gramos) => pagina.evaluate((g) => fetch('/api/balanza/simular', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ gramos: g }),
  }), gramos);
  // waitForFunction(fn, arg, opciones): sin el arg del medio el timeout no se aplica.
  // Espera a que la pantalla muestre ESE peso y estable: con solo "estable" se
  // colaba el peso anterior (en CI, mas lento, se tocaba el producto con la
  // balanza todavia moviendose y el servidor rechazaba la captura).
  const esperarPeso = (gramos) => pagina.waitForFunction((t) => {
    const n = document.querySelector('#pesoNumero');
    return n.classList.contains('estable') && n.textContent.trim() === t;
  }, (gramos / 1000).toFixed(3).replace('.', ','), { timeout: 15000 });
  const esperarGrupos = () => pagina.waitForFunction(
    () => !document.querySelector('#vistaGrupos').hasAttribute('hidden'), null, { timeout: 15000 });
  const enPicada = () => pagina.evaluate(() => document.body.classList.contains('modo-picada'));

  /** Arrastre con el mouse sobre la parte izquierda (dx < 0: hacia la izquierda). */
  async function deslizar(dx, sel) {
    const b = await pagina.locator(sel || '#vistaGrupos').boundingBox();
    dx = Math.sign(dx) * Math.min(Math.abs(dx), b.width * 0.6);
    const x = b.x + b.width * (dx < 0 ? 0.8 : 0.2), y = b.y + Math.min(160, b.height / 2);
    await pagina.mouse.move(x, y);
    await pagina.mouse.down();
    for (let i = 1; i <= 8; i++) await pagina.mouse.move(x + (dx * i) / 8, y + i);
    await pagina.mouse.up();
    await esperar(250);
  }

  async function cargar(grupo, producto, gramos) {
    await simular(0); await esperarPeso(0);
    await simular(gramos); await esperarPeso(gramos);
    await pagina.locator('.grupo', { hasText: grupo }).first().click();
    await pagina.locator('.prod', { hasText: producto }).first().click();
    await pagina.waitForFunction(() => !document.querySelector('#vistaConfirma').hidden ||
      document.querySelector('#hoja').classList.contains('abierta'), null, { timeout: 10000 });
  }

  try {
    await pagina.goto(URL, { waitUntil: 'networkidle' });
    await pagina.evaluate(() => { try { localStorage.removeItem('pos.picadaMermaKg'); localStorage.removeItem('pos.picadaGramosPersona'); } catch (e) {} });
    await pagina.reload({ waitUntil: 'networkidle' });
    await esperar(500);

    console.log('\n1. Deslizar de derecha a izquierda entra a la picada');
    await deslizar(-300);
    chequear('entra al modo picada', await enPicada());
    chequear('el panel dice "Simulación de picada"', (await texto('#carritoTitulo')) === 'Simulación de picada');
    chequear('se ve la fila de merma', await pagina.locator('#mermaKg').isVisible());
    chequear('se ve el aviso de simulación', await pagina.locator('#picadaBanner').isVisible());
    chequear('el pie de la venta no se ve', !(await pagina.locator('#ventaPie').isVisible()));
    chequear('el gesto no abrió ningún grupo', await pagina.locator('#vistaGrupos').isVisible());

    console.log('\n2. Merma y fiambres');
    await pagina.locator('#mermaKg').fill('1000');
    chequear('sin fiambre la merma es $0', (await texto('#mermaTotal')).includes('0,00'), await texto('#mermaTotal'));

    await cargar('Jamones', 'Jamón cocido', 250);
    chequear('la confirmación dice "Total de la picada"', (await texto('#confirmaTotalRotulo')) === 'Total de la picada');
    chequear('total en confirmación: 3.200 + merma 250', (await texto('#confirmaTotal')).includes('3.450'), await texto('#confirmaTotal'));
    await esperarGrupos();

    await cargar('Embutidos', 'Mortadela', 500);
    await esperarGrupos();

    const filas = await pagina.locator('#picadaItems .item-wrap').count();
    chequear('la picada tiene 2 fiambres', filas === 2, String(filas));
    const det = await pagina.locator('#picadaItems .item-detalle').allInnerTexts();
    chequear('cada fiambre muestra su cantidad', det[0].includes('0,250 kg') && det[1].includes('0,500 kg'), det.join(' | '));
    chequear('y su parte de la picada en %', det[0].includes('33%') && det[1].includes('67%'));
    const subs = await pagina.locator('#picadaItems .item-subtotal').allInnerTexts();
    chequear('y cuánto sale cada uno ($3.200 y $3.900)', subs[0].includes('3.200') && subs[1].includes('3.900'), subs.join(' | '));
    chequear('merma = 0,750 kg × $1.000 = $750', (await texto('#mermaTotal')).includes('750,00'), await texto('#mermaTotal'));
    chequear('peso total 0,750 kg', (await texto('#picadaKg')).includes('0,750'));
    chequear('total picada $7.850', (await texto('#picadaTotal')).includes('7.850'), await texto('#picadaTotal'));
    chequear('sale por kg: $7.850 / 0,750 kg = $10.467', (await texto('#picadaPorKg')).includes('10.467'), await texto('#picadaPorKg'));
    await pagina.screenshot({ path: path.join(SALIDA, 'picada-1-pc.png') });

    console.log('\n2b. Por persona');
    chequear('sin configurar no dice personas', (await texto('#picadaPersonas')) === '—');
    await pagina.locator('#gramosPersona').fill('150');
    chequear('0,750 kg a 150 g → 5 personas', (await texto('#picadaPersonas')) === '5 personas', await texto('#picadaPersonas'));
    chequear('la fila dice cuánto falta para una más', (await texto('#personaDetalle')) === 'faltan 150 g para 6', await texto('#personaDetalle'));
    chequear('la cabecera también', (await texto('#carritoContador')).includes('5 personas'), await texto('#carritoContador'));
    await pagina.locator('#gramosPersona').fill('200');
    chequear('a 200 g → 3 personas, faltan 50 g', (await texto('#picadaPersonas')) === '3 personas' &&
      (await texto('#personaDetalle')) === 'faltan 50 g para 4', await texto('#personaDetalle'));
    await pagina.locator('#gramosPersona').fill('150');

    console.log('\n3. La merma cambia en vivo y se recuerda');
    await pagina.locator('#mermaKg').fill('2000');
    chequear('merma nueva $1.500', (await texto('#mermaTotal')).includes('1.500'), await texto('#mermaTotal'));
    chequear('total $8.600', (await texto('#picadaTotal')).includes('8.600'), await texto('#picadaTotal'));

    console.log('\n4. Deslizar a la derecha vuelve a la venta, sin tocarla');
    await deslizar(300);
    chequear('sale del modo picada', !(await enPicada()));
    chequear('la venta sigue vacía', (await texto('#carritoContador')) === 'Sin artículos');
    chequear('se ve el botón de cerrar venta', await pagina.locator('#btnCobrar').isVisible());
    await deslizar(-300);
    chequear('al volver, la picada sigue ahí', (await pagina.locator('#picadaItems .item-wrap').count()) === 2);

    console.log('\n5. Deslizar sobre un grupo no lo abre');
    await deslizar(300, '.grupo >> nth=1');
    chequear('vuelve a la venta', !(await enPicada()));
    chequear('sigue en los grupos', await pagina.locator('#vistaGrupos').isVisible());
    await pagina.locator('#accesoPicada').click();
    chequear('el botón Picada también entra', await enPicada());

    console.log('\n6. Nueva picada');
    await pagina.locator('#btnPicadaNueva').click();
    await pagina.locator('.aviso-accion', { hasText: 'Borrar' }).click();
    chequear('la picada queda vacía', (await pagina.locator('#picadaItems .item-wrap').count()) === 0);
    chequear('total $0', (await texto('#picadaTotal')).includes('0,00'));
    await pagina.reload({ waitUntil: 'networkidle' });
    chequear('la merma por kg se recuerda en el equipo', (await pagina.locator('#mermaKg').inputValue()) === '2000');
    chequear('los gramos por persona también', (await pagina.locator('#gramosPersona').inputValue()) === '150');

    console.log('\n7. Celular');
    for (const [w, h] of [[360, 740], [820, 1180]]) {
      await pagina.setViewportSize({ width: w, height: h });
      await pagina.goto(URL, { waitUntil: 'networkidle' });
      await esperar(500);
      const bp = await pagina.locator('#accesoPicada').boundingBox();
      const ba = await pagina.locator('#accesoAdmin').boundingBox();
      const ancho = await pagina.evaluate(() => document.documentElement.scrollWidth);
      if (w <= 600) {
        chequear(`a ${w} px el botón Picada no se muestra (se entra deslizando)`, !bp && !!ba && ancho <= w);
      } else {
        chequear(`a ${w} px se ven los tres botones, sin desbordar`,
          !!bp && !!ba && bp.x >= 0 && ba.x + ba.width <= w + 0.5 && ancho <= w);
      }
    }
    await pagina.setViewportSize({ width: 360, height: 740 });
    await pagina.goto(URL, { waitUntil: 'networkidle' });
    await esperar(500);
    await deslizar(-220);
    chequear('en celular también entra deslizando', await enPicada());
    await cargar('Jamones', 'Jamón crudo', 200);
    await esperar(700);
    chequear('la hoja sube con la picada', await pagina.locator('#picadaItems .item-wrap').first().isVisible());
    await pagina.screenshot({ path: path.join(SALIDA, 'picada-2-celular.png') });

    console.log('\n8. Dedo de verdad (eventos táctiles): el navegador no se queda con el gesto');
    await pagina.setViewportSize({ width: 360, height: 740 });
    await pagina.goto(URL, { waitUntil: 'networkidle' });
    await esperar(500);
    const cdp = await ctx.newCDPSession(pagina);
    async function dedo(x0, x1, y) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] });
      for (let i = 1; i <= 10; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / 10, y: y + i }] });
        await esperar(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await esperar(300);
    }
    await dedo(320, 60, 400);
    chequear('deslizar con el dedo sobre un grupo entra a la picada', await enPicada());
    chequear('y no abre el grupo', await pagina.locator('#vistaGrupos').isVisible());
    await dedo(40, 320, 400);
    chequear('deslizar al revés vuelve a la venta', !(await enPicada()));

    chequear('no hubo errores de JavaScript', errores.length === 0, errores.join(' | '));
  } catch (e) {
    fallos++;
    console.log('Error en la prueba de picada:', e.message);
    // Para entender una falla en CI: que decia la pantalla en ese momento.
    try {
      const d = await pagina.evaluate(() => ({
        vista: ['vistaGrupos', 'vistaProductos', 'vistaConfirma'].filter((id) => !document.getElementById(id).hidden).join(','),
        peso: document.querySelector('#pesoNumero').className + ' ' + document.querySelector('#pesoNumero').textContent,
        avisos: document.querySelector('#avisos').innerText.replace(/\s+/g, ' '),
        picada: document.querySelectorAll('#picadaItems .item-wrap').length,
      }));
      console.log('  Pantalla:', JSON.stringify(d));
      await pagina.screenshot({ path: path.join(SALIDA, 'picada-error.png') });
    } catch (_) { /* la pagina puede no estar */ }
  }
  await navegador.close();
  console.log(fallos ? `\n  ${fallos} verificacion(es) fallaron.` : '\n  Todo bien.');
  terminar(fallos ? 1 : 0);
})();
