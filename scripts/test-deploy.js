'use strict';

/**
 * Prueba de lo que usa el actualizador automatico (instalador/actualizar.ps1):
 *   - GET /api/version
 *   - GET /api/deploy/ocupado: carrito con articulos, toques recientes,
 *     escrituras por la API, solo desde la misma PC
 *   - mensaje "version" por WebSocket (las pantallas se recargan solas)
 *
 * Usa config y base temporales en el puerto 3058: no toca lo real.
 *
 *   npm run test-deploy
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const RAIZ = path.join(__dirname, '..');
const PUERTO = 3058;
const URL = `http://localhost:${PUERTO}`;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

let fallos = 0;
function chequear(desc, cond, detalle) {
  if (!cond) fallos++;
  console.log(`  ${cond ? 'OK  ' : 'MAL '} ${desc}${detalle !== undefined ? '  -> ' + detalle : ''}`);
}

const get = (ruta) => fetch(URL + ruta).then((r) => r.json());
const ocupado = (seg) => get('/api/deploy/ocupado' + (seg !== undefined ? '?segundos=' + seg : ''));

function conectar() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PUERTO}/ws?estacion=e1`);
    ws.mensajes = [];
    ws.on('message', (d) => ws.mensajes.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function ipDeRed() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) if ((i.family === 'IPv4' || i.family === 4) && !i.internal) return i.address;
  }
  return null;
}

(async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-deploy-'));
  const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.example.json'), 'utf8'));
  cfg.http.port = PUERTO;
  cfg.balanzas[0].simulador = true;
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));

  const servidor = spawn(process.execPath, [path.join(RAIZ, 'src', 'server.js')], {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, POS_CONFIG: path.join(dir, 'config.json'), POS_DATA: dir, POS_SIN_SHEETS: '1' },
  });
  const terminar = (codigo) => {
    try { servidor.kill(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    process.exit(codigo);
  };

  try {
    for (let i = 0; i < 50; i++) {
      try { await fetch(URL + '/api/red'); break; } catch (_) { await esperar(200); }
    }

    console.log('\n1. Versión');
    const v = await get('/api/version');
    chequear('responde /api/version', v.ok && v.version && v.version.commit, JSON.stringify(v.version));
    chequear('trae la hora de arranque', !!v.iniciado);

    console.log('\n2. ¿Se puede reiniciar?');
    let o = await ocupado();
    chequear('sin equipos ni movimiento: libre', o.ok && o.ocupado === false, JSON.stringify(o.motivos));

    const ws = await conectar();
    await esperar(300);
    const msgV = ws.mensajes.find((m) => m.tipo === 'version');
    chequear('el equipo recibe la versión por WebSocket', msgV && msgV.version === v.version.commit);
    o = await ocupado();
    chequear('un equipo conectado sin tocar: libre', o.ocupado === false, JSON.stringify(o.motivos));

    ws.send(JSON.stringify({ tipo: 'carrito', items: 2 }));
    await esperar(200);
    o = await ocupado(0);
    chequear('carrito con 2 artículos: ocupado (aunque no haya espera)', o.ocupado === true && /2 art/.test(o.motivos.join()), o.motivos.join(' | '));

    ws.send(JSON.stringify({ tipo: 'carrito', items: 0 }));
    await esperar(200);
    o = await ocupado(0);
    chequear('carrito vacío: libre', o.ocupado === false, JSON.stringify(o.motivos));

    ws.send(JSON.stringify({ tipo: 'activo' }));
    await esperar(200);
    o = await ocupado(60);
    chequear('tocaron la pantalla hace instantes: ocupado', o.ocupado === true, o.motivos.join(' | '));
    await esperar(1100);
    o = await ocupado(1);
    chequear('pasada la espera: libre', o.ocupado === false, JSON.stringify(o.motivos));

    await fetch(URL + '/api/categorias', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nombre: 'Prueba deploy' }) });
    o = await ocupado(60);
    chequear('escritura por la API reciente: ocupado', o.ocupado === true && /API/.test(o.motivos.join()), o.motivos.join(' | '));

    ws.send(JSON.stringify({ tipo: 'carrito', items: 1 }));
    await esperar(200);
    ws.close();
    await esperar(300);
    o = await ocupado(0);
    chequear('el equipo con carrito se desconecta: ya no cuenta', o.ocupado === false, JSON.stringify(o.motivos));

    const ip = ipDeRed();
    if (ip) {
      const r = await fetch(`http://${ip}:${PUERTO}/api/deploy/ocupado`);
      chequear('desde otro equipo de la red: prohibido', r.status === 403, String(r.status));
    } else {
      console.log('  (sin IP de red para probar el acceso desde otro equipo)');
    }
  } catch (e) {
    console.error('\nError en la prueba:', e);
    fallos++;
  }

  console.log('\n---------------------------------------------');
  console.log(fallos ? `  ${fallos} verificacion(es) fallaron.` : '  Todo OK.');
  console.log('---------------------------------------------\n');
  terminar(fallos ? 1 : 0);
})();
