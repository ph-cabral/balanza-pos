'use strict';

/**
 * Puertos serie compartidos entre balanzas y escaneres.
 *
 * Con un solo equipo alcanzaba con "si COM4 no existe, usar el FTDI". Con dos
 * balanzas (dos FTDI) eso es ambiguo, asi que:
 *
 *  1. Si el equipo tiene `numeroSerie`, se busca el adaptador por ese numero,
 *     este en el COM que este. Es la forma segura de atar cada balanza/escaner
 *     a su cable: Windows puede cambiar el numero de COM, el de serie no.
 *  2. Si no, se usa el `puerto` configurado, si existe y nadie mas lo tiene.
 *  3. Si no existe y `autodeteccion` esta activa, se elige un adaptador libre
 *     solo cuando hay UNO que cumpla (nunca se adivina entre dos).
 *
 * Cada driver "reclama" el puerto que abrio para que otro no lo tome. La
 * resolucion se hace en fila (uno por vez) para que dos drivers arrancando
 * juntos no elijan el mismo adaptador.
 */

const VID_FTDI = '0403';

/** ruta en mayusculas -> id del equipo que la usa */
const reclamos = new Map();
let fila = Promise.resolve();

function norm(s) { return String(s || '').trim().toUpperCase(); }

function reclamar(dueno, ruta) {
  liberar(dueno);
  if (ruta) reclamos.set(norm(ruta), dueno);
}

function liberar(dueno) {
  for (const [ruta, d] of reclamos) if (d === dueno) reclamos.delete(ruta);
}

function duenoDe(ruta) { return reclamos.get(norm(ruta)) || null; }

async function listar() {
  const { SerialPort } = require('serialport');
  const lista = await SerialPort.list();
  return lista.map((p) => ({
    path: p.path,
    fabricante: p.manufacturer || '',
    numeroSerie: p.serialNumber || '',
    vendorId: String(p.vendorId || '').toLowerCase(),
    productId: String(p.productId || '').toLowerCase(),
  }));
}

/**
 * Decide que puerto abrir. Devuelve { ruta, aviso } o { ruta: null, error }.
 * `tipo` es 'balanza' o 'escaner' (cambia la preferencia de autodeteccion).
 * `configurados` son los puertos que otros equipos tienen puestos a mano en su
 * config: la autodeteccion no los toca aunque todavia no esten abiertos.
 */
function resolver({ dueno, cfg, tipo, configurados = [] }) {
  const tarea = fila.then(() => _resolver({ dueno, cfg, tipo, configurados }));
  fila = tarea.catch(() => {});
  return tarea;
}

async function _resolver({ dueno, cfg, tipo, configurados }) {
  let puertos;
  try { puertos = await listar(); } catch (_) {
    // Sin poder listar, se intenta el configurado tal cual.
    reclamar(dueno, cfg.puerto);
    return { ruta: cfg.puerto, puertos: [] };
  }

  const ajeno = (p) => {
    const d = duenoDe(p.path);
    return d && d !== dueno;
  };
  const vistos = puertos.map((p) => p.path + (p.numeroSerie ? ` [${p.numeroSerie}]` : ''));

  // 1. Por numero de serie del adaptador.
  if (norm(cfg.numeroSerie)) {
    const p = puertos.find((x) => norm(x.numeroSerie) === norm(cfg.numeroSerie));
    if (!p) {
      return {
        ruta: null, puertos: vistos,
        error: `No está conectado el adaptador con número de serie ${cfg.numeroSerie}.` +
          (vistos.length ? ` Puertos en esta PC: ${vistos.join(', ')}.` : ' Esta PC no ve ningún puerto COM.'),
      };
    }
    if (ajeno(p)) {
      return { ruta: null, puertos: vistos, error: `${p.path} (serie ${p.numeroSerie}) ya lo está usando otro equipo.` };
    }
    reclamar(dueno, p.path);
    const aviso = norm(p.path) !== norm(cfg.puerto)
      ? `adaptador ${cfg.numeroSerie} encontrado en ${p.path} (config decía ${cfg.puerto || 'nada'})`
      : null;
    return { ruta: p.path, puertos: vistos, aviso };
  }

  // 2. El puerto configurado, si existe.
  const configurado = puertos.find((p) => norm(p.path) === norm(cfg.puerto));
  if (configurado) {
    if (ajeno(configurado)) {
      return { ruta: null, puertos: vistos, error: `${configurado.path} ya lo está usando otro equipo.` };
    }
    reclamar(dueno, configurado.path);
    return { ruta: configurado.path, puertos: vistos };
  }

  // 3. Autodeteccion: un unico candidato libre.
  if (cfg.autodeteccion !== false && puertos.length) {
    const reservados = new Set(configurados.map(norm));
    const libres = puertos.filter((p) => p.vendorId && !ajeno(p) && !reservados.has(norm(p.path)));
    let elegido = null;
    if (tipo === 'balanza') {
      const ftdi = libres.filter((p) => p.vendorId === VID_FTDI);
      if (ftdi.length === 1) elegido = ftdi[0];
      else if (!ftdi.length && libres.length === 1) elegido = libres[0];
    } else {
      // Un escaner no deberia quedarse con el FTDI de una balanza.
      const otros = libres.filter((p) => p.vendorId !== VID_FTDI);
      if (otros.length === 1) elegido = otros[0];
    }
    if (elegido) {
      reclamar(dueno, elegido.path);
      return {
        ruta: elegido.path, puertos: vistos,
        aviso: `${cfg.puerto || '(sin puerto)'} no existe en esta PC; se usa ${elegido.path} (${elegido.fabricante || 'USB'})`,
      };
    }
  }

  // Nada claro: se intenta el configurado y el error de apertura lo explica.
  reclamar(dueno, cfg.puerto);
  return { ruta: cfg.puerto, puertos: vistos };
}

module.exports = { listar, resolver, reclamar, liberar, duenoDe, VID_FTDI };
