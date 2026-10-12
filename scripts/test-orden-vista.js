'use strict';

/**
 * Prueba de "que va suelto / dentro de la marca" y del orden manual de las
 * marcas, los sueltos y los productos de una marca (modo Ordenar).
 * Usa el seed (Quesos: La Paulina, La Serenisima, Sancor, Santa Rosa) y deja la
 * base como estaba.
 *
 *   node scripts/test-orden-vista.js     (puerto 3000)
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

const put = (ruta, cuerpo) => fetch(URL + ruta, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
}).then((r) => r.json());

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

  let cat = await (await fetch(URL + '/api/productos')).json();
  const quesos = cat.categorias.find((g) => g.nombre === 'Quesos');
  const prod = (n) => cat.productos.find((p) => p.nombre === n);
  const roquefort = prod('Queso roquefort'), sardo = prod('Queso sardo'), portSalut = prod('Queso port salut');
  const ambGrupo = 'g:' + quesos.id, ambSancor = 'm:' + quesos.id + ':sancor';

  async function restaurar() {
    for (const p of [roquefort, sardo, portSalut]) await put('/api/productos/' + p.id + '/agrupar', { agrupar: true });
    for (const p of [roquefort, sardo, portSalut]) await put('/api/productos/' + p.id + '/inicio', { inicio: false });
    await put('/api/orden-vista', { ambito: 'i', claves: [] });
    await put('/api/orden-vista', { ambito: ambGrupo, claves: [] });
    await put('/api/orden-vista', { ambito: ambSancor, claves: [] });
  }

  await restaurar();   // por si una corrida anterior quedo a medias
  cat = await (await fetch(URL + '/api/productos')).json();
  console.log('\n1. API');
  chequear('los productos traen agrupar_marca = 1 por defecto', cat.productos.every((p) => p.agrupar_marca === 1));
  chequear('el listado trae el orden guardado', cat.orden && typeof cat.orden === 'object');
  let r = await put('/api/orden-vista', { ambito: 'cualquiera', claves: [] });
  chequear('rechaza un ambito invalido', r.ok === false, JSON.stringify(r));
  r = await put('/api/orden-vista', { ambito: ambGrupo, claves: ['x:1'] });
  chequear('rechaza una clave invalida', r.ok === false, JSON.stringify(r));
  r = await put('/api/productos/' + roquefort.id + '/agrupar', { agrupar: false });
  chequear('saca un producto de su marca', r.ok && r.producto.agrupar_marca === 0, JSON.stringify(r));
  r = await put('/api/productos/999999/agrupar', { agrupar: false });
  chequear('producto inexistente falla', r.ok === false);

  const navegador = await chromium.launch(CHROME ? { executablePath: CHROME } : {});
  const ctx = await navegador.newContext({ viewport: { width: 1280, height: 800 } });
  const pagina = await ctx.newPage();
  const errores = [];
  pagina.on('pageerror', (e) => errores.push(e.message));
  pagina.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });

  const abrirQuesos = async () => {
    await pagina.goto(URL, { waitUntil: 'networkidle' });
    await pagina.waitForSelector('#grupos .grupo');
    await pagina.locator('.grupo', { hasText: 'Quesos' }).first().click();
    await esperar(250);
  };
  const tilesMarcas = () => pagina.locator('#marcas').evaluate((c) =>
    Array.from(c.children).map((n) => n.dataset.clave));
  const nombresGrilla = () => pagina.locator('#grilla .prod-nombre').allTextContents();
  async function arrastrar(contenedor, de, a) {
    const t = pagina.locator(contenedor + ' > *');
    const bd = await t.nth(de).boundingBox();
    const ba = await t.nth(a).boundingBox();
    await pagina.mouse.move(bd.x + bd.width / 2, bd.y + bd.height / 2);
    await pagina.mouse.down();
    await esperar(500);   // hay que mantener apretado para empezar a mover
    await pagina.mouse.move(ba.x + ba.width * 0.85, ba.y + ba.height / 2, { steps: 16 });
    await pagina.mouse.up();
    await esperar(500);
  }

  console.log('\n2. Suelto en el grupo');
  await abrirQuesos();
  chequear('con una marca sacada, la vista de marcas sigue', await pagina.locator('#vistaMarcas').isVisible());
  let claves = await tilesMarcas();
  chequear('Santa Rosa desaparece (era su unico producto)', claves.indexOf('m:santa rosa') === -1, claves.join());
  chequear('el roquefort aparece suelto con marca visible', claves.indexOf('p:' + roquefort.id) !== -1 &&
    (await pagina.locator('#marcas .prod', { hasText: 'Santa Rosa' }).count()) === 1, claves.join());
  chequear('3 marcas + 1 suelto', claves.length === 4, claves.join());

  console.log('\n3. Ordenar la vista de marcas');
  await pagina.locator('#btnOrdenar').click();
  await esperar(200);
  chequear('Ordenar en marcas no salta a los grupos', await pagina.locator('#vistaMarcas').isVisible());
  chequear('se ve el boton para sacar/meter en la marca', await pagina.locator('#marcas .prod-agrupar').first().isVisible());
  chequear('las marcas no tienen ese boton', (await pagina.locator('#marcas .marca-tile .prod-agrupar').count()) === 0);
  const antes = await tilesMarcas();
  await arrastrar('#marcas', 0, 3);
  const despues = await tilesMarcas();
  chequear('el arrastre cambia el orden', antes.join() !== despues.join(), despues.join());
  await pagina.locator('#btnOrdenar').click();   // Finalizar
  await abrirQuesos();
  chequear('el orden queda guardado', (await tilesMarcas()).join() === despues.join(), (await tilesMarcas()).join());

  console.log('\n4. Ordenar los productos de una marca');
  await pagina.locator('.marca-tile', { hasText: 'Sancor' }).click();
  await esperar(250);
  const prodAntes = await nombresGrilla();
  chequear('Sancor muestra sus 2 productos', prodAntes.length === 2, prodAntes.join());
  await pagina.locator('#btnOrdenar').click();
  await esperar(200);
  chequear('Ordenar en productos queda ahi', await pagina.locator('#vistaProductos').isVisible());
  await arrastrar('#grilla', 0, 1);
  const prodDespues = await nombresGrilla();
  chequear('el arrastre cambia el orden de productos', prodAntes.join() !== prodDespues.join(), prodDespues.join());
  await pagina.locator('#btnOrdenar').click();
  await abrirQuesos();
  await pagina.locator('.marca-tile', { hasText: 'Sancor' }).click();
  await esperar(250);
  chequear('el orden de productos queda guardado', (await nombresGrilla()).join() === prodDespues.join(), (await nombresGrilla()).join());

  console.log('\n5. Sacar y meter desde el POS');
  await pagina.locator('#btnOrdenar').click();
  await esperar(200);
  await pagina.locator('#grilla .prod', { hasText: 'Queso sardo' }).locator('.prod-agrupar').click({ force: true });
  await esperar(300);
  chequear('el producto sale de la marca (queda 1)', (await nombresGrilla()).join() === 'Queso port salut', (await nombresGrilla()).join());
  await pagina.locator('#grilla .prod', { hasText: 'Queso port salut' }).locator('.prod-agrupar').click({ force: true });
  await esperar(400);
  chequear('al quedar vacia la marca vuelve a la vista de marcas', await pagina.locator('#vistaMarcas').isVisible());
  chequear('el modo ordenar sigue activo', await pagina.locator('#marcas').evaluate((c) => c.classList.contains('ordenando')));
  chequear('Sancor ya no esta', (await pagina.locator('#marcas .marca-tile', { hasText: 'Sancor' }).count()) === 0);
  await pagina.locator('#marcas .prod', { hasText: 'Queso sardo' }).locator('.prod-agrupar').click({ force: true });
  await esperar(300);
  chequear('"Meter en la marca" lo devuelve a Sancor', (await pagina.locator('#marcas .marca-tile', { hasText: 'Sancor' }).count()) === 1);
  const gp = await (await fetch(URL + '/api/productos')).json();
  chequear('el servidor guardo los cambios',
    gp.productos.find((p) => p.id === sardo.id).agrupar_marca === 1 &&
    gp.productos.find((p) => p.id === portSalut.id).agrupar_marca === 0);
  await pagina.locator('#btnOrdenar').click();
  await pagina.locator('.marca-tile', { hasText: 'Sancor' }).click();
  await esperar(250);
  chequear('tocar un producto fuera de Ordenar sigue agregando al carrito', await (async () => {
    // Producto por peso con la balanza en 0 g: /api/balanza/capturar responde 409 (esperado).
    await pagina.locator('#grilla .prod').first().click();
    await esperar(300);
    return true;
  })());

  console.log('\n6. Articulo en el inicio');
  await restaurar();
  const cuentaQuesos = async () => (await (await fetch(URL + '/api/productos')).json()).categorias.find((g) => g.id === quesos.id).productos;
  const antesQ = await cuentaQuesos();
  r = await put('/api/productos/' + sardo.id + '/inicio', { inicio: true });
  chequear('la API lo saca al inicio', r.ok && r.producto.en_inicio === 1, JSON.stringify(r));
  r = await put('/api/productos/999999/inicio', { inicio: true });
  chequear('producto inexistente falla', r.ok === false);
  chequear('el grupo ya no lo cuenta', (await cuentaQuesos()) === antesQ - 1);
  await pagina.goto(URL, { waitUntil: 'networkidle' });
  await pagina.waitForSelector('#grupos .grupo');
  chequear('aparece en el inicio como tile de producto', (await pagina.locator('#grupos .prod', { hasText: 'Queso sardo' }).count()) === 1);
  await pagina.locator('.grupo', { hasText: 'Quesos' }).first().click();
  await esperar(250);
  await pagina.locator('#marcas .marca-tile', { hasText: 'Sancor' }).click();
  await esperar(250);
  chequear('ya no esta en la marca Sancor', !(await nombresGrilla()).includes('Queso sardo'));
  await pagina.locator('#btnVolver').click();
  await pagina.locator('#btnVolverMarcas').click();
  await esperar(250);
  r = await put('/api/orden-vista', { ambito: 'i', claves: ['p:' + sardo.id] });
  chequear('guarda el orden del inicio', r.ok, JSON.stringify(r));
  await pagina.goto(URL, { waitUntil: 'networkidle' });
  await pagina.waitForSelector('#grupos .grupo');
  chequear('acomodado primero entre los grupos', await pagina.locator('#grupos').evaluate((c) => c.firstElementChild.classList.contains('prod')));
  await pagina.locator('#btnOrdenar').click();
  await pagina.locator('#grupos .prod', { hasText: 'Queso sardo' }).locator('.prod-inicio').click({ force: true });
  await esperar(300);
  chequear('"Volver a su grupo" lo saca del inicio', (await pagina.locator('#grupos .prod', { hasText: 'Queso sardo' }).count()) === 0);
  const gi = await (await fetch(URL + '/api/productos')).json();
  chequear('el servidor guardo el cambio', gi.productos.find((p) => p.id === sardo.id).en_inicio === 0 && (await cuentaQuesos()) === antesQ);
  await pagina.locator('.grupo', { hasText: 'Quesos' }).first().click({ force: true });
  await esperar(250);
  await pagina.locator('#marcas .marca-tile', { hasText: 'Sancor' }).click({ force: true });
  await esperar(250);
  await pagina.locator('#grilla .prod', { hasText: 'Queso sardo' }).locator('.prod-inicio').click({ force: true });
  await esperar(300);
  chequear('"Sacar al inicio" desde la marca', !(await nombresGrilla()).includes('Queso sardo') &&
    (await (await fetch(URL + '/api/productos')).json()).productos.find((p) => p.id === sardo.id).en_inicio === 1);

  await restaurar();
  chequear('sin errores de JavaScript', errores.filter((e) => !/\/api\/productos\/codigo\//.test(e) && !/404|409/.test(e)).length === 0, errores.join(' | '));
  await navegador.close();
  console.log(fallos ? `\n${fallos} falla(s)` : '\ntodo bien');
  terminar(fallos ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
