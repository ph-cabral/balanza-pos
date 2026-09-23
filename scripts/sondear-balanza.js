'use strict';

/**
 * Sondeo exhaustivo de balanza.
 *
 * A diferencia de detect-scale.js, este script:
 *   - prueba tambien formatos 7E1 y 7O1 (no solo 8N1),
 *   - ademas de escuchar, MANDA comandos de pedido de peso, porque muchas
 *     balanzas comerciales no transmiten solas: contestan cuando se les pide,
 *   - fuerza RTS y DTR activos (algunas balanzas no habilitan la salida sin eso),
 *   - muestra en hexadecimal CUALQUIER byte que llegue, aunque no sea una trama
 *     valida. Un solo byte basura ya es informacion: significa que el cable
 *     conduce y que la velocidad esta cerca.
 *
 *   node scripts/sondear-balanza.js COM4              -> sondeo rapido
 *   node scripts/sondear-balanza.js COM4 --completo   -> todas las combinaciones
 */

const { SerialPort } = require('serialport');

const puerto = process.argv[2] || 'COM4';
const completo = process.argv.includes('--completo');

const VELOCIDADES = completo
  ? [9600, 4800, 19200, 2400, 1200, 38400, 57600]
  : [9600, 4800, 19200, 2400];

// 8N2 va primero: es el formato que declara el manual de la Kretz Novel Eco 2
// (9600, 8 bits de datos, sin paridad, 2 bits de stop).
const FORMATOS = [
  { dataBits: 8, parity: 'none', stopBits: 2, etiqueta: '8N2' },
  { dataBits: 8, parity: 'none', stopBits: 1, etiqueta: '8N1' },
  { dataBits: 7, parity: 'even', stopBits: 1, etiqueta: '7E1' },
  { dataBits: 7, parity: 'odd',  stopBits: 1, etiqueta: '7O1' },
];

// Comandos de pedido mas usados en balanzas comerciales. Se prueban todos.
const COMANDOS = [
  // El modo "a pedido" de las Kretz responde a P, p, W o w sueltos, sin CR.
  { nombre: 'P',      bytes: Buffer.from('P', 'latin1') },
  { nombre: 'p',      bytes: Buffer.from('p', 'latin1') },
  { nombre: 'W',      bytes: Buffer.from('W', 'latin1') },
  { nombre: 'w',      bytes: Buffer.from('w', 'latin1') },
  { nombre: 'ENQ',    bytes: Buffer.from([0x05]) },
  { nombre: 'P+CR',   bytes: Buffer.from('P\r', 'latin1') },
  { nombre: 'W+CR',   bytes: Buffer.from('W\r', 'latin1') },
  { nombre: 'S+CR',   bytes: Buffer.from('S\r', 'latin1') },
  { nombre: 'T+CR',   bytes: Buffer.from('T\r', 'latin1') },
  { nombre: '?+CR',   bytes: Buffer.from('?\r', 'latin1') },
  { nombre: 'CR',     bytes: Buffer.from('\r', 'latin1') },
  { nombre: 'DC1',    bytes: Buffer.from([0x11]) },
];

const hallazgos = [];
let ecoDetectado = false;

function abrir(baudRate, fmt) {
  return new Promise((resolve) => {
    let port;
    try {
      port = new SerialPort({
        path: puerto,
        baudRate,
        dataBits: fmt.dataBits,
        parity: fmt.parity,
        stopBits: fmt.stopBits,
        autoOpen: false,
      });
    } catch (e) {
      return resolve({ error: e.message });
    }
    port.open((err) => {
      if (err) return resolve({ error: err.message });
      // Algunas balanzas necesitan estas lineas activas para habilitar la salida.
      port.set({ rts: true, dtr: true }, () => resolve({ port }));
    });
  });
}

function cerrar(port) {
  return new Promise((resolve) => {
    if (!port || !port.isOpen) return resolve();
    port.close(() => resolve());
  });
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function mostrarBytes(etiqueta, buf) {
  const hex = buf.toString('hex').match(/../g).join(' ');
  const txt = buf.toString('latin1').replace(/[\x00-\x1F\x7F]/g, '.');
  console.log(`      ${etiqueta}`);
  console.log(`        hex   : ${hex}`);
  console.log(`        texto : "${txt}"`);
}

async function sondear(baudRate, fmt) {
  const r = await abrir(baudRate, fmt);
  if (r.error) {
    console.log(`  ${String(baudRate).padEnd(6)} ${fmt.etiqueta} -> no abre (${r.error})`);
    return;
  }
  const { port } = r;

  let recibido = Buffer.alloc(0);
  port.on('data', (c) => { recibido = Buffer.concat([recibido, c]); });
  port.on('error', () => {});

  // --- Fase pasiva: escuchar sin pedir nada ---
  await esperar(2000);
  if (recibido.length) {
    console.log(`  ${String(baudRate).padEnd(6)} ${fmt.etiqueta} -> ${recibido.length} bytes SIN pedir (transmision continua)`);
    mostrarBytes('llegada espontanea:', recibido.slice(0, 64));
    hallazgos.push({ baudRate, fmt: fmt.etiqueta, modo: 'continuo', bytes: recibido.length });
    await cerrar(port);
    return;
  }

  // --- Fase activa: pedirle el peso ---
  let respondio = false;
  let eco = 0;
  for (const cmd of COMANDOS) {
    recibido = Buffer.alloc(0);
    try { port.write(cmd.bytes); } catch (_) { continue; }
    await esperar(450);
    if (recibido.length) {
      // Si vuelve exactamente lo que mandamos, no es la balanza: es el puente
      // de loopback todavia puesto entre los pines 2 y 3.
      if (recibido.equals(cmd.bytes)) {
        eco++;
        continue;
      }
      if (!respondio) {
        console.log(`  ${String(baudRate).padEnd(6)} ${fmt.etiqueta} -> RESPONDE a comando`);
        respondio = true;
      }
      mostrarBytes(`comando ${cmd.nombre} -> ${recibido.length} bytes:`, recibido.slice(0, 64));
      hallazgos.push({ baudRate, fmt: fmt.etiqueta, modo: `comando ${cmd.nombre}`, bytes: recibido.length });
    }
  }

  if (respondio) {
    // nada mas que informar
  } else if (eco) {
    console.log(`  ${String(baudRate).padEnd(6)} ${fmt.etiqueta} -> ECO (${eco}/${COMANDOS.length}): volvio lo mismo que se mando`);
    ecoDetectado = true;
  } else {
    console.log(`  ${String(baudRate).padEnd(6)} ${fmt.etiqueta} -> silencio total`);
  }
  await cerrar(port);
}

(async function main() {
  console.log('\nPuertos disponibles:');
  for (const p of await SerialPort.list()) {
    console.log(`  ${p.path.padEnd(10)} ${p.manufacturer || ''} ${p.friendlyName || ''}`);
  }

  console.log(`\nSondeando ${puerto}. Dejá peso apoyado en la balanza durante todo el test.`);
  console.log(`${VELOCIDADES.length * FORMATOS.length} combinaciones, ~5s cada una.\n`);

  for (const baud of VELOCIDADES) {
    for (const fmt of FORMATOS) {
      await sondear(baud, fmt);
      await esperar(300);
    }
  }

  console.log('\n---------------------------------------------------------');
  if (ecoDetectado && !hallazgos.length) {
    console.log('SE DETECTO ECO: volvio exactamente lo que se mando.');
    console.log('');
    console.log('El puente de loopback entre los pines 2 y 3 sigue puesto.');
    console.log('Eso confirma que el adaptador funciona bien, pero impide');
    console.log('hablar con la balanza.');
    console.log('');
    console.log('Sacá el puente, conectá la balanza y volve a correr.');
  } else if (hallazgos.length) {
    console.log('LLEGARON DATOS en estas combinaciones:\n');
    for (const h of hallazgos) {
      console.log(`  ${h.baudRate} ${h.fmt} — ${h.modo} — ${h.bytes} bytes`);
    }
    console.log('\nCopiá la salida completa para ajustar el parser.');
  } else {
    console.log('No llego un solo byte en ninguna combinacion.');
    console.log('');
    console.log('Con el puerto abriendo bien, eso deja tres causas posibles:');
    console.log('  1. La salida serie esta desactivada en el menu de la balanza.');
    console.log('  2. El cable no tiene el pinout que espera la balanza (TX/RX).');
    console.log('  3. El conector de la balanza no es el de datos.');
    console.log('');
    console.log('Para separar 2 de las otras: puenteá los pines 2 y 3 del DB9 del');
    console.log('adaptador USB (sin la balanza) y corre  node scripts/loopback.js COM4');
  }
  console.log('---------------------------------------------------------\n');
  process.exit(0);
})();
