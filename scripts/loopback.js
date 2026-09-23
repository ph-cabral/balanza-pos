'use strict';

/**
 * Prueba de lazo (loopback) del adaptador USB-serie.
 *
 * Hace DOS pruebas independientes:
 *
 *   A) Datos  — puente entre pines 2 y 3 (RX y TX).
 *      Manda un texto y espera que vuelva.
 *
 *   B) Control — puente entre pines 7 y 8 (RTS y CTS).
 *      Mueve RTS y mira si CTS lo sigue. Esto no usa TX/RX para nada,
 *      asi que distingue un chip roto de un puente mal hecho.
 *
 * Si B funciona y A no, el chip esta vivo y el puente de 2-3 no hizo contacto.
 * Si las dos fallan con los puentes bien hechos, el adaptador no sirve.
 *
 *   node scripts/loopback.js COM4
 */

const { SerialPort } = require('serialport');

const puerto = process.argv[2] || 'COM4';
const PRUEBA = 'LOOPBACK-OK-123';

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const leerLineas = (port) => new Promise((r) => port.get((e, s) => r(e ? null : s)));
const ponerRts = (port, v) => new Promise((r) => port.set({ rts: v }, () => r()));

const port = new SerialPort({ path: puerto, baudRate: 9600 }, async (err) => {
  if (err) {
    console.error(`\nNo se pudo abrir ${puerto}: ${err.message}\n`);
    process.exit(1);
  }

  // ---- Prueba A: datos (pines 2-3) ----
  console.log(`\n[A] DATOS — requiere puente entre pines 2 y 3`);
  console.log(`    Enviando "${PRUEBA}" y esperando 3 segundos...`);

  let recibido = '';
  port.on('data', (c) => { recibido += c.toString('latin1'); });
  port.write(PRUEBA);
  await esperar(3000);

  const datosOk = recibido.includes(PRUEBA);
  if (datosOk) {
    console.log(`    Volvio: "${recibido}"  -> OK\n`);
  } else if (recibido.length) {
    console.log(`    Volvio algo distinto: "${recibido}"  -> con ruido\n`);
  } else {
    console.log(`    No volvio nada.\n`);
  }

  // ---- Prueba B: lineas de control (pines 7-8) ----
  console.log(`[B] CONTROL — requiere puente entre pines 7 y 8`);

  await ponerRts(port, false);
  await esperar(250);
  const bajo = await leerLineas(port);

  await ponerRts(port, true);
  await esperar(250);
  const alto = await leerLineas(port);

  let controlOk = false;
  if (!bajo || !alto) {
    console.log('    No se pudieron leer las lineas de control.\n');
  } else {
    console.log(`    RTS apagado -> CTS = ${bajo.cts}`);
    console.log(`    RTS activo  -> CTS = ${alto.cts}`);
    controlOk = bajo.cts !== alto.cts;
    console.log(controlOk
      ? '    CTS sigue a RTS -> OK\n'
      : '    CTS no reacciona.\n');
  }

  // ---- Veredicto ----
  console.log('---------------------------------------------------------');
  if (datosOk) {
    console.log('EL ADAPTADOR FUNCIONA.');
    console.log('El problema esta en el cable hacia la balanza o en la balanza.');
  } else if (controlOk) {
    console.log('EL CHIP ESTA VIVO (las lineas de control responden),');
    console.log('pero no volvieron los datos.');
    console.log('');
    console.log('Casi seguro el puente entre 2 y 3 no hizo contacto.');
    console.log('Rehacelo y volve a correr esta prueba.');
  } else {
    console.log('NI DATOS NI CONTROL.');
    console.log('');
    console.log('O los dos puentes estan mal hechos, o el adaptador no sirve.');
    console.log('Ojo con los FTDI falsificados: enumeran como COM pero no');
    console.log('transmiten. Se ven en Administrador de dispositivos si el');
    console.log('driver reporta una version rara o el VID/PID no es 0403.');
  }
  console.log('---------------------------------------------------------\n');

  port.close(() => process.exit(0));
});
