'use strict';

/**
 * Driver de balanza.
 *
 * Lee el puerto serie, arma las lineas, las parsea y mantiene el estado actual
 * del peso. Emite 'estado' cuando algo cambia (limitado a unas pocas veces por
 * segundo para no cargar la CPU de la PC).
 *
 * Modos:
 *  - simulador: no toca hardware, genera pesos. Sirve para probar toda la app.
 *  - real: abre el puerto COM configurado.
 *  - autodeteccion: si el protocolo es "auto", aprende cual parser funciona con
 *    las primeras tramas que llegan y despues se queda con ese.
 *
 * Si la balanza no manda flag de estabilidad, el driver la deduce: N lecturas
 * seguidas dentro de una tolerancia = peso estable.
 */

const EventEmitter = require('events');
const { parsearAuto, parsearCon } = require('./parsers');
const puertos = require('../puertos');

/** Cuantas lecturas tarda el simulador en asentarse en el peso nuevo. */
const SIM_PASOS = 5;

/** Pasado este tiempo sin datos, el ultimo peso leido se considera viejo. */
const MS_LECTURA_VIEJA = 2500;

class BalanzaDriver extends EventEmitter {
  /**
   * @param config   config de esta balanza (puerto, protocolo, ...)
   * @param opciones id y nombre (para logs y reclamo de puerto) y
   *                 configurados(): puertos puestos a mano en los otros equipos.
   */
  constructor(config, opciones = {}) {
    super();
    this.config = config;
    this.id = opciones.id || config.id || 'balanza';
    this.nombre = opciones.nombre || config.nombre || 'balanza';
    this._configurados = opciones.configurados || (() => []);

    this.estado = {
      conectado: false,
      simulador: !!config.simulador,
      gramos: 0,
      estable: false,
      protocolo: config.protocolo || 'auto',
      puerto: config.puerto,
      error: null,
      ultimaLectura: null,
    };

    this._buffer = '';
    this._historial = [];
    this._protocoloDetectado = config.protocolo !== 'auto' ? config.protocolo : null;
    this._port = null;
    this._timerReconexion = null;
    this._timerSim = null;
    this._ultimoEmit = 0;
    this._pendiente = false;
    this._intervaloEmit = Math.max(50, Math.round(1000 / (config.broadcastHz || 6)));
    this._ultimasCrudas = [];
  }

  // --- Ciclo de vida --------------------------------------------------------

  iniciar() {
    this._detenido = false;
    if (this.config.simulador) return this._iniciarSimulador();
    return this._abrirPuerto();
  }

  detener() {
    this._detenido = true;
    this._gen = (this._gen || 0) + 1;
    clearTimeout(this._timerReconexion);
    clearInterval(this._timerSim);
    this._timerReconexion = null;
    this._timerSim = null;
    if (this._port && this._port.isOpen) {
      try { this._port.close(); } catch (_) { /* ya estaba cerrado */ }
    }
    this._port = null;
    this.estado.conectado = false;
    puertos.liberar(this.id);
  }

  /** Reinicia el driver con una config nueva (desde el panel de admin). */
  reconfigurar(config) {
    this.detener();
    this.config = config;
    this.nombre = config.nombre || this.nombre;
    this.estado.simulador = !!config.simulador;
    this.estado.puerto = config.puerto;
    this.estado.protocolo = config.protocolo || 'auto';
    this.estado.error = null;
    this._protocoloDetectado = config.protocolo !== 'auto' ? config.protocolo : null;
    this._historial = [];
    this._buffer = '';
    this._intervaloEmit = Math.max(50, Math.round(1000 / (config.broadcastHz || 6)));
    this.iniciar();
  }

  /** Ultimas tramas crudas recibidas. Sirve para diagnosticar desde el admin. */
  tramasCrudas() {
    return this._ultimasCrudas.slice(-25);
  }

  // --- Modo simulador -------------------------------------------------------

  _iniciarSimulador() {
    this.estado.conectado = true;
    this.estado.simulador = true;
    this.estado.protocolo = 'simulador';
    this.estado.error = null;

    this._simObjetivo = 0;
    this._simDesde = 0;
    this._simPasos = 0;

    // Imita el comportamiento real: al cambiar el peso oscila unos instantes
    // ("estabilizando") y despues queda clavado en el valor exacto.
    this._timerSim = setInterval(() => {
      let valor;

      if (this._simPasos > 0) {
        // Transicion con ruido: se ve como cuando se apoya algo en el plato.
        const avance = 1 - this._simPasos / SIM_PASOS;
        valor = this._simDesde + (this._simObjetivo - this._simDesde) * avance
              + (Math.random() - 0.5) * 14;
        this._simPasos--;
      } else {
        valor = this._simObjetivo;
      }

      const gramos = Math.max(0, Math.round(valor));
      this._procesarLectura({
        gramos,
        estable: null, // la deduce el driver, igual que con una balanza real
        crudo: `SIM ${(gramos / 1000).toFixed(3)} kg`,
      });
    }, 120);

    this.emit('estado', this.snapshot());
  }

  /** Fija el peso del simulador (botones de prueba de la UI). */
  simularPeso(gramos) {
    if (!this.config.simulador) return false;
    this._simDesde = this._simObjetivo;
    this._simObjetivo = Math.max(0, Math.round(gramos));
    this._simPasos = SIM_PASOS;
    // Arranca inestable, como cuando se apoya algo en el plato. Marcamos el
    // estado ya mismo para que nadie capture el peso anterior en el intervalo
    // que va hasta la proxima lectura.
    this._historial = [];
    this.estado.estable = false;
    this.emit('estado', this.snapshot());
    return true;
  }

  // --- Modo real ------------------------------------------------------------

  _abrirPuerto() {
    let SerialPort;
    try {
      ({ SerialPort } = require('serialport'));
    } catch (e) {
      this.estado.error =
        'El modulo serialport no esta instalado. Corre "npm install" o dejá la balanza en modo simulador.';
      this.estado.conectado = false;
      this.emit('estado', this.snapshot());
      return;
    }

    // Que puerto abrir: por numero de serie del adaptador, el COM configurado
    // o, si no existe, el unico adaptador libre (ver src/puertos.js).
    const gen = this._gen = (this._gen || 0) + 1;
    puertos.resolver({
      dueno: this.id,
      cfg: this.config,
      tipo: 'balanza',
      configurados: this._configurados(),
    }).then((r) => {
      if (gen !== this._gen) return; // se detuvo mientras tanto
      this._puertosVistos = r.puertos;
      if (!r.ruta) return this._fallo(r.error);
      if (r.aviso && this._avisoPuerto !== r.aviso) {
        console.log(`  [${this.nombre}] ${r.aviso}`);
        this._avisoPuerto = r.aviso;
      }
      this._abrirEn(SerialPort, r.ruta);
    });
  }

  _abrirEn(SerialPort, ruta) {
    if (this.config.simulador) return;
    const cfg = { ...this.config, puerto: ruta };
    this.estado.puerto = ruta;
    try {
      this._port = new SerialPort({
        path: cfg.puerto,
        baudRate: Number(cfg.baudRate) || 9600,
        dataBits: Number(cfg.dataBits) || 8,
        parity: cfg.parity || 'none',
        stopBits: Number(cfg.stopBits) || 1,
        autoOpen: false,
      });
    } catch (e) {
      return this._fallo(e.message);
    }

    this._port.open((err) => {
      if (this._detenido) return;
      if (err) {
        const hay = this._puertosVistos && this._puertosVistos.length
          ? ` Puertos en esta PC: ${this._puertosVistos.join(', ')}.`
          : ' Esta PC no ve ningún puerto COM: revisar el cable USB y el driver del adaptador.';
        return this._fallo(`No se pudo abrir ${cfg.puerto}: ${err.message}.${hay}`);
      }
      this.estado.conectado = true;
      this.estado.error = null;
      this.emit('estado', this.snapshot());
    });

    // Los eventos de un puerto viejo (despues de reconfigurar o dar de baja la
    // balanza) no deben tocar el estado ni reabrir nada.
    const port = this._port;
    port.on('data', (chunk) => { if (this._port === port) this._onData(chunk); });
    port.on('error', (err) => { if (this._port === port) this._fallo(err.message); });
    port.on('close', () => {
      if (this._port !== port) return;
      this.estado.conectado = false;
      this.emit('estado', this.snapshot());
      this._programarReconexion();
    });
  }

  _fallo(mensaje) {
    this.estado.conectado = false;
    this.estado.error = mensaje;
    this.emit('estado', this.snapshot());
    this._programarReconexion();
  }

  _programarReconexion() {
    if (this.config.simulador || this._detenido) return;
    clearTimeout(this._timerReconexion);
    this._timerReconexion = setTimeout(() => this._abrirPuerto(), 3000);
  }

  // --- Procesamiento de datos ----------------------------------------------

  _onData(chunk) {
    this._buffer += chunk.toString('latin1');

    // Evita que el buffer crezca si la balanza manda basura sin terminadores.
    if (this._buffer.length > 4096) this._buffer = this._buffer.slice(-1024);

    // Las balanzas terminan la trama con CR, LF, CRLF o ETX segun el modelo.
    const partes = this._buffer.split(/[\r\n\x03]+/);
    this._buffer = partes.pop();

    for (const linea of partes) {
      if (!linea.trim()) continue;
      this._ultimasCrudas.push(linea);
      if (this._ultimasCrudas.length > 50) this._ultimasCrudas.shift();

      const r = this._protocoloDetectado
        ? parsearCon(this._protocoloDetectado, linea)
        : parsearAuto(linea);

      if (!r) continue;

      // Primera trama valida en modo auto: nos quedamos con ese parser.
      if (!this._protocoloDetectado && r.protocolo) {
        this._protocoloDetectado = r.protocolo;
        this.estado.protocolo = r.protocolo;
      }

      this._procesarLectura(r);
    }
  }

  _procesarLectura({ gramos, estable, crudo }) {
    const tolerancia = Math.round((this.config.toleranciaEstabilidadKg ?? 0.002) * 1000);
    const necesarias = this.config.lecturasParaEstable || 4;

    this._historial.push(gramos);
    if (this._historial.length > necesarias) this._historial.shift();

    // Si la balanza informa estabilidad, le creemos. Si no, la deducimos.
    let esEstable;
    if (estable === true || estable === false) {
      esEstable = estable;
    } else {
      esEstable =
        this._historial.length >= necesarias &&
        Math.max(...this._historial) - Math.min(...this._historial) <= tolerancia;
    }

    this.estado.gramos = gramos;
    this.estado.estable = esEstable;
    this.estado.conectado = true;
    this.estado.ultimaLectura = Date.now();
    this.estado.crudo = crudo;

    this._emitirLimitado();
  }

  /** No emitimos en cada trama: la balanza manda ~10/seg y no hace falta. */
  _emitirLimitado() {
    const ahora = Date.now();
    const desde = ahora - this._ultimoEmit;
    if (desde >= this._intervaloEmit) {
      this._ultimoEmit = ahora;
      this.emit('estado', this.snapshot());
    } else if (!this._pendiente) {
      this._pendiente = true;
      setTimeout(() => {
        this._pendiente = false;
        this._ultimoEmit = Date.now();
        this.emit('estado', this.snapshot());
      }, this._intervaloEmit - desde);
    }
  }

  /**
   * Si la balanza dejo de mandar datos (se desenchufo el cable, se apago),
   * el ultimo peso leido queda viejo. No se puede vender con ese numero.
   */
  _lecturaVencida() {
    if (!this.estado.ultimaLectura) return true;
    return Date.now() - this.estado.ultimaLectura > MS_LECTURA_VIEJA;
  }

  snapshot() {
    const vencida = this._lecturaVencida();
    return {
      id: this.id,
      nombre: this.nombre,
      conectado: this.estado.conectado && !vencida,
      simulador: this.estado.simulador,
      gramos: this.estado.gramos,
      estable: this.estado.estable && !vencida,
      protocolo: this.estado.protocolo,
      puerto: this.estado.simulador ? 'simulador' : this.estado.puerto,
      error: vencida && this.estado.conectado
        ? 'La balanza dejó de enviar datos'
        : this.estado.error,
      crudo: this.estado.crudo || null,
    };
  }

  /**
   * Devuelve el peso para capturar. Solo entrega un valor si esta estable
   * y por encima del minimo: evita agregar al carrito un peso "en movimiento".
   */
  capturar() {
    const minimo = Math.round((this.config.pesoMinimoKg ?? 0.005) * 1000);
    const s = this.snapshot();
    if (!s.conectado) return { ok: false, motivo: 'La balanza no esta conectada' };
    if (!s.estable) return { ok: false, motivo: 'El peso todavia no se estabilizo' };
    if (s.gramos < minimo) return { ok: false, motivo: 'No hay peso en la balanza' };
    return { ok: true, gramos: s.gramos };
  }
}

module.exports = BalanzaDriver;
