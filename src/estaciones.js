'use strict';

/**
 * Estaciones de trabajo: cada puesto de venta tiene (opcionalmente) una balanza
 * y un escaner asignados. Las balanzas y los escaneres estan enchufados a la PC
 * servidor; los equipos de venta (tablet, celular, PC) eligen en que estacion
 * trabajan y reciben solo el peso y los codigos de esa estacion.
 *
 * Todo vive en config.json:
 *
 *   "balanzas":   [{ id, nombre, simulador, puerto, numeroSerie, baudRate, ... }]
 *   "escaneres":  [{ id, nombre, simulador, puerto, numeroSerie, baudRate, ... }]
 *   "estaciones": [{ id, nombre, balanza, escaner }]   (balanza/escaner = id o null)
 *
 * Un config.json viejo (con un solo objeto "balanza") se lee como una balanza
 * "b1" y una estacion "Mostrador 1" que la usa: con un solo equipo todo sigue
 * igual que antes.
 */

const EventEmitter = require('events');
const BalanzaDriver = require('./scale/driver');
const EscanerDriver = require('./escaner/driver');

const BALANZA_BASE = {
  simulador: false,
  puerto: '',
  numeroSerie: '',
  baudRate: 9600,
  dataBits: 8,
  parity: 'none',
  stopBits: 2,
  protocolo: 'kretz',
  autodeteccion: true,
  lecturasParaEstable: 4,
  toleranciaEstabilidadKg: 0.002,
  pesoMinimoKg: 0.005,
  broadcastHz: 6,
};

const ESCANER_BASE = {
  simulador: false,
  puerto: '',
  numeroSerie: '',
  baudRate: 9600,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  autodeteccion: false,
};

const ID_VALIDO = /^[a-z0-9_-]{1,20}$/i;

function texto(v, max = 40) { return String(v == null ? '' : v).trim().slice(0, max); }

/** Normaliza (y migra) las tres listas. No toca el resto de config. */
function normalizar(config) {
  let balanzas = Array.isArray(config.balanzas) ? config.balanzas : null;
  let escaneres = Array.isArray(config.escaneres) ? config.escaneres : [];
  let estaciones = Array.isArray(config.estaciones) ? config.estaciones : null;

  // Migracion desde el formato de una sola balanza.
  if (!balanzas) {
    balanzas = config.balanza ? [{ id: 'b1', nombre: 'Balanza 1', ...config.balanza }] : [];
  }
  // "estado" viene de GET /api/dispositivos (estado en vivo): no es config.
  const sinEstado = (x) => { const { estado, ...resto } = x || {}; return resto; };
  balanzas = balanzas.map(sinEstado).map((b, i) => ({
    ...BALANZA_BASE,
    ...b,
    id: ID_VALIDO.test(b.id || '') ? b.id : `b${i + 1}`,
    nombre: texto(b.nombre) || `Balanza ${i + 1}`,
    numeroSerie: texto(b.numeroSerie, 64),
    puerto: texto(b.puerto, 64),
    simulador: !!b.simulador,
  }));
  escaneres = escaneres.map(sinEstado).map((s, i) => ({
    ...ESCANER_BASE,
    ...s,
    id: ID_VALIDO.test(s.id || '') ? s.id : `s${i + 1}`,
    nombre: texto(s.nombre) || `Escáner ${i + 1}`,
    numeroSerie: texto(s.numeroSerie, 64),
    puerto: texto(s.puerto, 64),
    simulador: !!s.simulador,
  }));

  if (!estaciones || !estaciones.length) {
    estaciones = [{ id: 'e1', nombre: 'Mostrador 1', balanza: balanzas[0] ? balanzas[0].id : null, escaner: null }];
  }
  const idsB = new Set(balanzas.map((b) => b.id));
  const idsS = new Set(escaneres.map((s) => s.id));
  estaciones = estaciones.map((e, i) => ({
    id: ID_VALIDO.test(e.id || '') ? e.id : `e${i + 1}`,
    nombre: texto(e.nombre) || `Mostrador ${i + 1}`,
    balanza: idsB.has(e.balanza) ? e.balanza : null,
    escaner: idsS.has(e.escaner) ? e.escaner : null,
  }));

  return { balanzas, escaneres, estaciones };
}

/** Errores de una config enviada desde administracion (array vacio = valida). */
function validar(nueva) {
  const errores = [];
  const repetido = (lista, campo, que) => {
    const vistos = new Map();
    for (const x of lista) {
      const v = String(x[campo] || '').trim().toUpperCase();
      if (!v) continue;
      if (vistos.has(v)) errores.push(`${que} repetido: ${x[campo]} (${vistos.get(v)} y ${x.nombre})`);
      else vistos.set(v, x.nombre);
    }
  };
  const todos = [...nueva.balanzas, ...nueva.escaneres];
  repetido(todos, 'id', 'Id');
  repetido(nueva.estaciones, 'id', 'Id de estación');
  repetido(nueva.estaciones, 'nombre', 'Nombre de estación');
  repetido(todos.filter((x) => !x.simulador), 'puerto', 'Puerto');
  repetido(todos.filter((x) => !x.simulador), 'numeroSerie', 'Número de serie');
  if (!nueva.estaciones.length) errores.push('Tiene que haber al menos una estación.');
  for (const x of todos) {
    if (!x.simulador && !x.puerto && !x.numeroSerie) {
      errores.push(`${x.nombre}: falta el puerto o el número de serie del adaptador (o activar el simulador).`);
    }
  }
  // Un equipo en dos estaciones a la vez: el peso se veria en las dos y el
  // escaner mandaria a las dos. No tiene sentido fisico.
  const usoB = new Map();
  const usoS = new Map();
  for (const e of nueva.estaciones) {
    if (e.balanza) {
      if (usoB.has(e.balanza)) errores.push(`La misma balanza está en ${usoB.get(e.balanza)} y en ${e.nombre}.`);
      usoB.set(e.balanza, e.nombre);
    }
    if (e.escaner) {
      if (usoS.has(e.escaner)) errores.push(`El mismo escáner está en ${usoS.get(e.escaner)} y en ${e.nombre}.`);
      usoS.set(e.escaner, e.nombre);
    }
  }
  return errores;
}

class Estaciones extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    const n = normalizar(config);
    this.lista = n;
    this.balanzas = new Map();   // id -> BalanzaDriver
    this.escaneres = new Map();  // id -> EscanerDriver
    this._firmas = new Map();    // id -> JSON de la config con la que arranco
  }

  iniciar() { this._sincronizarDrivers(); }

  detener() {
    for (const d of this.balanzas.values()) d.detener();
    for (const d of this.escaneres.values()) d.detener();
  }

  /** Puertos puestos a mano en los otros equipos (la autodeteccion no los toca). */
  _configurados(excepto) {
    return [...this.lista.balanzas, ...this.lista.escaneres]
      .filter((x) => x.id !== excepto && !x.simulador && x.puerto)
      .map((x) => x.puerto);
  }

  /** Crea, reconfigura o detiene drivers segun la lista actual. Solo reinicia los que cambiaron. */
  _sincronizarDrivers() {
    const sincronizar = (lista, mapa, Clase, evento) => {
      const ids = new Set(lista.map((x) => x.id));
      for (const [id, d] of mapa) {
        if (!ids.has(id)) { d.detener(); mapa.delete(id); this._firmas.delete(id); }
      }
      for (const cfg of lista) {
        const firma = JSON.stringify(cfg);
        const actual = mapa.get(cfg.id);
        if (actual) {
          if (this._firmas.get(cfg.id) !== firma) actual.reconfigurar({ ...cfg });
        } else {
          const d = new Clase({ ...cfg }, {
            id: cfg.id,
            nombre: cfg.nombre,
            configurados: () => this._configurados(cfg.id),
          });
          d.on('estado', (estado) => this.emit(evento, cfg.id, estado));
          if (evento === 'escaner') d.on('codigo', (codigo) => this.emit('codigo', cfg.id, codigo));
          mapa.set(cfg.id, d);
          d.iniciar();
        }
        this._firmas.set(cfg.id, firma);
      }
    };
    // Primero se sueltan los puertos de lo que se da de baja o cambia, despues
    // se abre lo nuevo (sincronizar recorre bajas antes que altas).
    sincronizar(this.lista.balanzas, this.balanzas, BalanzaDriver, 'balanza');
    sincronizar(this.lista.escaneres, this.escaneres, EscanerDriver, 'escaner');
  }

  /** Aplica una config nueva de administracion. Tira Error si no es valida. */
  aplicar(entrada) {
    if (!Array.isArray(entrada.estaciones) || !entrada.estaciones.length) {
      throw new Error('Tiene que haber al menos una estación.');
    }
    const nueva = normalizar({
      balanzas: entrada.balanzas || [],
      escaneres: entrada.escaneres || [],
      estaciones: entrada.estaciones || [],
    });
    // normalizar descarta referencias rotas en silencio; para administracion
    // preferimos avisar.
    const idsB = new Set(nueva.balanzas.map((b) => b.id));
    const idsS = new Set(nueva.escaneres.map((s) => s.id));
    const errores = validar(nueva);
    for (const e of entrada.estaciones || []) {
      if (e.balanza && !idsB.has(e.balanza)) errores.push(`${e.nombre}: la balanza asignada no existe.`);
      if (e.escaner && !idsS.has(e.escaner)) errores.push(`${e.nombre}: el escáner asignado no existe.`);
    }
    if (errores.length) {
      const err = new Error(errores.join(' '));
      err.errores = errores;
      throw err;
    }
    this.lista = nueva;
    this._escribirEnConfig();
    this._sincronizarDrivers();
    this.emit('cambio', this.publico());
    return this.publico();
  }

  /** Cambia la config de una balanza (compatibilidad con PUT /api/balanza/config). */
  actualizarBalanza(id, cambios) {
    const lista = this.lista.balanzas.map((b) => (b.id === id ? { ...b, ...cambios, id } : b));
    return this.aplicar({ ...this.lista, balanzas: lista });
  }

  _escribirEnConfig() {
    this.config.balanzas = this.lista.balanzas;
    this.config.escaneres = this.lista.escaneres;
    this.config.estaciones = this.lista.estaciones;
    // El formato viejo queda reemplazado por "balanzas".
    delete this.config.balanza;
  }

  // --- Consultas ------------------------------------------------------------

  estacion(id) {
    return this.lista.estaciones.find((e) => e.id === id) || null;
  }

  /** La estacion pedida o, si no existe / no vino, la primera. */
  estacionOPrimera(id) {
    return this.estacion(id) || this.lista.estaciones[0];
  }

  balanza(id) { return this.balanzas.get(id) || null; }
  escaner(id) { return this.escaneres.get(id) || null; }

  balanzaDeEstacion(estId) {
    const e = this.estacionOPrimera(estId);
    return e && e.balanza ? this.balanza(e.balanza) : null;
  }

  configBalanza(id) { return this.lista.balanzas.find((b) => b.id === id) || null; }

  /** Estaciones que usan una balanza / un escaner. */
  estacionesConBalanza(id) { return this.lista.estaciones.filter((e) => e.balanza === id); }
  estacionesConEscaner(id) { return this.lista.estaciones.filter((e) => e.escaner === id); }

  /** Estado de una balanza para una estacion sin balanza asignada. */
  static sinBalanza() {
    return {
      id: null, nombre: null, conectado: false, simulador: false, gramos: 0, estable: false,
      protocolo: null, puerto: null, error: 'Esta estación no tiene balanza asignada', sinBalanza: true,
    };
  }

  estadoBalanzaDeEstacion(estId) {
    const d = this.balanzaDeEstacion(estId);
    return d ? d.snapshot() : Estaciones.sinBalanza();
  }

  estadoEscanerDeEstacion(estId) {
    const e = this.estacionOPrimera(estId);
    const d = e && e.escaner ? this.escaner(e.escaner) : null;
    return d ? d.snapshot() : null;
  }

  /** Lo que ven los equipos de venta al elegir estacion. */
  resumenEstaciones() {
    const nom = (lista, id) => { const x = lista.find((y) => y.id === id); return x ? x.nombre : null; };
    return this.lista.estaciones.map((e) => ({
      ...e,
      balanzaNombre: nom(this.lista.balanzas, e.balanza),
      escanerNombre: nom(this.lista.escaneres, e.escaner),
    }));
  }

  /** Config completa + estado en vivo, para administracion. */
  publico() {
    return {
      balanzas: this.lista.balanzas.map((b) => ({ ...b, estado: this.balanza(b.id) ? this.balanza(b.id).snapshot() : null })),
      escaneres: this.lista.escaneres.map((s) => ({ ...s, estado: this.escaner(s.id) ? this.escaner(s.id).snapshot() : null })),
      estaciones: this.resumenEstaciones(),
    };
  }
}

module.exports = Estaciones;
module.exports.normalizar = normalizar;
module.exports.validar = validar;
module.exports.BALANZA_BASE = BALANZA_BASE;
module.exports.ESCANER_BASE = ESCANER_BASE;
