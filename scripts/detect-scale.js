'use strict';

/**
 * Diagnostico de balanza.
 *
 *   npm run ports    -> lista los puertos COM disponibles
 *   npm run detect   -> prueba el puerto de config.json a varias velocidades
 *   node scripts/detect-scale.js COM4          -> prueba ese puerto
 *   node scripts/detect-scale.js COM4 9600     -> ese puerto y esa velocidad
 *
 * Con algo apoyado en la balanza, el script muestra las tramas crudas (texto y
 * hexadecimal) y que parser las entiende. Esa salida es lo unico que hace falta
 * para dejar la lectura fina con el modelo real.
 */

const path = require('path');
const fs = require('fs');
const { parsearAuto } = require('../src/scale/parsers');

const VELOCIDADES = [9600, 4800, 19200, 2400, 1200, 38400, 57600];
const SEGUNDOS_POR_VELOCIDAD = 4;

let SerialPort;
try {
  ({ SerialPort } = require('serialport'));
} catch (e) {
  console.error('\nFalta el modulo serialport. Corre primero:  npm install\n');
  process.exit(1);
}

const args = process.argv.slice(2);

async function listarPuertos() {
  const puertos = await SerialPort.list();
  console.log('\nPuertos disponibles:');
  if (!puertos.length) {
    console.log('  (ninguno) — revisa que el cable USB-serie este enchufado y con driver instalado.');
  }
  for (const p of puertos) {
    const serie = p.serialNumber ? `  serie ${p.serialNumber}` : '';
    const vidpid = p.vendorId ? `  VID ${p.vendorId}:${p.productId || '?'}` : '';
    console.log(`  ${p.path.padEnd(10)} ${p.manufacturer || ''} ${p.friendlyName || ''}${vidpid}${serie}`);
  }
  console.log('');
  return puertos;
}

function probar(puerto, baudRate, segundos) {
  return new Promise((resolve) => {
    const lineas = [];
    let buffer = '';
    let port;

    try {
      port = new SerialPort({ path: puerto, baudRate, autoOpen: false });
    } catch (e) {
      console.log(`  ${baudRate} baudios -> no se pudo abrir (${e.message})`);
      return resolve([]);
    }

    // El cierre es asincronico: hay que esperar el callback antes de seguir,
    // si no el intento siguiente encuentra el puerto todavia tomado y falla
    // con "Access denied".
    let cerrando = false;
    const cerrar = () => {
      if (cerrando) return;
      cerrando = true;
      if (!port.isOpen) return resolve(lineas);
      port.close(() => resolve(lineas));
    };

    port.open((err) => {
      if (err) {
        console.log(`  ${baudRate} baudios -> ${err.message}`);
        return resolve([]);
      }
      setTimeout(cerrar, segundos * 1000);
    });

    port.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      const partes = buffer.split(/[\r\n\x03]+/);
      buffer = partes.pop();
      for (const l of partes) {
        if (l.trim() && lineas.length < 12) lineas.push(l);
      }
    });

    port.on('error', () => cerrar());
  });
}

function mostrar(lineas, baudRate) {
  if (!lineas.length) {
    console.log(`  ${String(baudRate).padEnd(6)} -> sin datos`);
    return false;
  }

  console.log(`\n  ${baudRate} baudios -> ${lineas.length} trama(s):`);
  let reconocidas = 0;

  for (const l of lineas.slice(0, 6)) {
    const hex = Buffer.from(l, 'latin1').toString('hex').match(/../g).join(' ');
    const visible = l.replace(/[\x00-\x1F\x7F]/g, '.');
    const r = parsearAuto(l);

    console.log(`    texto : "${visible}"`);
    console.log(`    hex   : ${hex}`);
    if (r) {
      reconocidas++;
      console.log(`    LEIDO : ${(r.gramos / 1000).toFixed(3)} kg  ` +
        `(parser "${r.protocolo}"${r.estable === null ? '' : r.estable ? ', estable' : ', inestable'})`);
    } else {
      console.log('    LEIDO : (ningun parser entendio esta trama)');
    }
    console.log('');
  }

  if (reconocidas) {
    console.log(`  >>> ESTA VELOCIDAD FUNCIONA: ${baudRate} baudios <<<\n`);
    return true;
  }
  console.log('  Llegan datos pero no se entienden. Copiá las lineas de arriba ' +
    '(texto + hex) para ajustar el parser.\n');
  return false;
}

(async function main() {
  if (args[0] === '--list' || args[0] === '-l') {
    await listarPuertos();
    return;
  }

  let puerto = args[0];
  if (!puerto) {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    const b = (cfg.balanzas && cfg.balanzas[0]) || cfg.balanza || {};
    puerto = b.puerto;
  }

  await listarPuertos();

  console.log(`Probando ${puerto}.`);
  console.log('Dejá algo apoyado en la balanza mientras corre el test.\n');

  const velocidades = args[1] ? [Number(args[1])] : VELOCIDADES;
  let encontrada = null;

  for (const baud of velocidades) {
    const lineas = await probar(puerto, baud, SEGUNDOS_POR_VELOCIDAD);
    if (mostrar(lineas, baud) && !encontrada) encontrada = baud;
    // Respiro para que Windows libere del todo el handle del puerto.
    await new Promise((r) => setTimeout(r, 600));
  }

  console.log('---------------------------------------------------------');
  if (encontrada) {
    console.log(`Listo. Poné en config.json:  "puerto": "${puerto}", "baudRate": ${encontrada},`);
    console.log('y  "simulador": false');
  } else {
    console.log('No se detecto una velocidad que funcione.');
    console.log('Cosas para revisar:');
    console.log('  - Que la balanza tenga activada la salida serie en su menu de configuracion.');
    console.log('  - Que sea transmision continua (algunas mandan solo al apretar una tecla).');
    console.log('  - Que el cable sea null-modem / cruzado si el directo no da senal.');
    console.log('  - Probar otro puerto COM de la lista de arriba.');
  }
  console.log('---------------------------------------------------------\n');
  process.exit(0);
})();
