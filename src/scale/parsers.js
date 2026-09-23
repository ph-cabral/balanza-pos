'use strict';

/**
 * Parsers de tramas de balanza.
 *
 * Todavia no sabemos que balanza se va a usar, asi que hay varios parsers y el
 * driver elige el que funcione (o probalos todos con `npm run detect`).
 *
 * Todos devuelven el peso en GRAMOS (entero) o null si la trama no matchea:
 *   { gramos, estable, neto, crudo }
 *
 * Cuando sepamos el modelo real, lo unico que hay que tocar es este archivo:
 * agregar el parser exacto y ponerlo primero en la lista.
 */

/** Pasa un numero + unidad a gramos enteros. */
function aGramos(valor, unidad) {
  const u = (unidad || 'kg').toLowerCase();
  if (u === 'g' || u === 'gr') return Math.round(valor);
  if (u === 'lb') return Math.round(valor * 453.59237);
  if (u === 'oz') return Math.round(valor * 28.349523);
  return Math.round(valor * 1000); // kg por defecto
}

/** Limpia caracteres de control dejando la linea legible. */
function limpiar(linea) {
  return linea
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Kretz Novel Eco 2 (y familia Kretz), modo "Transmision continua de PESO".
 *
 * Trama real capturada del equipo:
 *   02 30 30 2e 32 33 35 0d   ->   STX "00.235" CR
 *
 * Es peso en kilos con tres decimales, enmarcado entre STX (0x02) y retorno de
 * carro. El driver ya corta por CR, asi que aca llega el STX pegado al numero.
 *
 * No informa estabilidad ni neto/bruto: la estabilidad la deduce el driver por
 * repeticion de lecturas.
 *
 * Puerto: 9600 baudios, 8 bits de datos, sin paridad, 2 bits de STOP.
 */
function parserKretz(linea) {
  const m = linea.match(/^\x02?\s*([+-]?\d{1,3}[.,]\d{3})\s*$/);
  if (!m) return null;
  const valor = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(valor)) return null;
  return {
    gramos: Math.round(valor * 1000),
    estable: null, // lo decide el driver
    neto: false,
    crudo: limpiar(linea),
  };
}

/**
 * Formato continuo tipo Toledo / CAS / Rhino y compatibles.
 * Ejemplos: "ST,GS,+  1.234kg"  "US,NT,  0.500 kg"  "ST,GS,0.500kg"
 */
function parserToledo(linea) {
  const s = limpiar(linea).toUpperCase();
  const m = s.match(/\b(ST|US|OL)\b\s*,\s*\b(GS|NT)\b\s*,?\s*([+-]?\s*[\d]+(?:[.,]\d+)?)\s*(KG|G|LB|OZ)?/);
  if (!m) return null;
  const valor = parseFloat(m[3].replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(valor)) return null;
  return {
    gramos: aGramos(valor, m[4] || 'kg'),
    estable: m[1] === 'ST',
    neto: m[2] === 'NT',
    crudo: s,
  };
}

/**
 * Formato con flag de estabilidad de una sola letra al principio.
 * Ejemplos: "S  1.234 kg"   "U  0.500 kg"   "S+1.234kg"
 */
function parserFlagCorto(linea) {
  const s = limpiar(linea).toUpperCase();
  const m = s.match(/^([SU])\s*([+-]?\s*\d+(?:[.,]\d+)?)\s*(KG|G|LB)?$/);
  if (!m) return null;
  const valor = parseFloat(m[2].replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(valor)) return null;
  return {
    gramos: aGramos(valor, m[3] || 'kg'),
    estable: m[1] === 'S',
    neto: false,
    crudo: s,
  };
}

/**
 * Solo peso, sin flags. Es el formato mas comun en balanzas simples.
 * Ejemplos: "1.234"   "  0.500 kg"   "0,750KG"   "500 g"
 * Como no informa estabilidad, el driver la deduce por repeticion de lecturas.
 */
function parserSoloPeso(linea) {
  const s = limpiar(linea).toUpperCase();
  const m = s.match(/^([+-]?\s*\d+(?:[.,]\d+)?)\s*(KG|GR|G|LB)?$/);
  if (!m) return null;
  const valor = parseFloat(m[1].replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(valor)) return null;
  // Sin unidad explicita asumimos kg, salvo que sea un entero grande (gramos).
  let unidad = m[2];
  if (!unidad) unidad = (!m[1].includes('.') && !m[1].includes(',') && Math.abs(valor) > 100) ? 'g' : 'kg';
  return {
    gramos: aGramos(valor, unidad),
    estable: null, // lo decide el driver
    neto: false,
    crudo: s,
  };
}

/**
 * Trama con etiqueta antes del numero.
 * Ejemplos: "PESO: 1.234 kg"   "NET 0.500 KG"   "W: 1.234kg"
 */
function parserEtiquetado(linea) {
  const s = limpiar(linea).toUpperCase();
  const m = s.match(/\b(PESO|NET|NETO|GROSS|BRUTO|W|WT)\b\s*[:=]?\s*([+-]?\s*\d+(?:[.,]\d+)?)\s*(KG|GR|G|LB)?/);
  if (!m) return null;
  const valor = parseFloat(m[2].replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(valor)) return null;
  return {
    gramos: aGramos(valor, m[3] || 'kg'),
    estable: null,
    neto: /NET/.test(m[1]),
    crudo: s,
  };
}

/**
 * Ultimo recurso: busca cualquier numero decimal con unidad opcional en la linea.
 * Sirve para tramas raras que no encajan en ninguno de los anteriores.
 */
function parserGenerico(linea) {
  const s = limpiar(linea).toUpperCase();
  if (!s) return null;
  const m = s.match(/([+-]?\d+(?:[.,]\d+)?)\s*(KG|GR|G|LB)?/);
  if (!m) return null;
  const valor = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(valor)) return null;
  let unidad = m[2];
  if (!unidad) unidad = (!m[1].includes('.') && !m[1].includes(',') && Math.abs(valor) > 100) ? 'g' : 'kg';
  const estable = /\bST\b|^S\b/.test(s) ? true : (/\bUS\b|^U\b/.test(s) ? false : null);
  return { gramos: aGramos(valor, unidad), estable, neto: false, crudo: s };
}

/** Orden de prueba: del mas especifico al mas permisivo. */
const PARSERS = [
  { nombre: 'kretz', fn: parserKretz },
  { nombre: 'toledo', fn: parserToledo },
  { nombre: 'flagCorto', fn: parserFlagCorto },
  { nombre: 'etiquetado', fn: parserEtiquetado },
  { nombre: 'soloPeso', fn: parserSoloPeso },
  { nombre: 'generico', fn: parserGenerico },
];

/** Corre un parser puntual por nombre. */
function parsearCon(nombre, linea) {
  const p = PARSERS.find((x) => x.nombre === nombre);
  if (!p) return null;
  return p.fn(linea);
}

/**
 * Prueba todos los parsers y devuelve el primero que matchee,
 * junto con el nombre del que funciono.
 */
function parsearAuto(linea) {
  for (const p of PARSERS) {
    const r = p.fn(linea);
    if (r && Number.isFinite(r.gramos)) {
      return { ...r, protocolo: p.nombre };
    }
  }
  return null;
}

module.exports = { PARSERS, parsearCon, parsearAuto, aGramos, limpiar };
