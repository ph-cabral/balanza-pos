'use strict';

/**
 * Driver de escaner de codigo de barras por puerto serie.
 *
 * Por que serie y no "teclado": un escaner USB de fabrica se comporta como un
 * teclado y escribe en la ventana que tenga el foco de la PC donde esta
 * enchufado. Con los escaneres conectados a la PC servidor y la venta hecha
 * desde tablets/celulares, eso no sirve: hay que leerlos en el servidor y
 * mandar cada codigo a su estacion. Casi todos los escaneres tienen un modo
 * "USB COM" / "USB CDC" / "Virtual COM" que se activa leyendo un codigo de
 * configuracion del manual; en ese modo aparecen como un puerto COM y mandan
 * cada lectura como una linea terminada en CR y/o LF.
 *
 * (En Windows no se puede leer por separado dos escaneres en modo teclado: el
 * sistema se queda con los teclados y los mezcla en uno solo.)
 *
 * Emite:
 *   'codigo' (codigo)  cada lectura
 *   'estado' (snapshot) cuando cambia la conexion
 */

const EventEmitter = require('events');
const puertos = require('../puertos');

const MIN_LARGO = 3;

class EscanerDriver extends EventEmitter {
  constructor(config, opciones = {}) {
    super();
    this.config = config;
    this.id = opciones.id || config.id || 'escaner';
    this.nombre = opciones.nombre || config.nombre || 'escaner';
    this._configurados = opciones.configurados || (() => []);
    this._buffer = '';
    this._port = null;
    this._timerReconexion = null;
    this.estado = {
      conectado: false,
      simulador: !!config.simulador,
      puerto: config.puerto || '',
      error: null,
      ultimoCodigo: null,
      ultimoEn: null,
      lecturas: 0,
    };
  }

  iniciar() {
    this._detenido = false;
    if (this.config.simulador) {
      this.estado.conectado = true;
      this.estado.simulador = true;
      this.estado.error = null;
      this.emit('estado', this.snapshot());
      return;
    }
    this._abrirPuerto();
  }

  detener() {
    this._detenido = true;
    this._gen = (this._gen || 0) + 1;
    clearTimeout(this._timerReconexion);
    this._timerReconexion = null;
    const port = this._port;
    this._port = null;
    if (port && port.isOpen) {
      try { port.close(); } catch (_) { /* ya cerrado */ }
    }
    this.estado.conectado = false;
    puertos.liberar(this.id);
  }

  reconfigurar(config) {
    this.detener();
    this.config = config;
    this.nombre = config.nombre || this.nombre;
    this.estado.simulador = !!config.simulador;
    this.estado.puerto = config.puerto || '';
    this.estado.error = null;
    this._buffer = '';
    this.iniciar();
  }

  /** Lectura de prueba (modo simulador, o para probar la ruta a la estacion). */
  simularCodigo(codigo) {
    this._emitirCodigo(String(codigo || ''));
    return true;
  }

  _abrirPuerto() {
    let SerialPort;
    try {
      ({ SerialPort } = require('serialport'));
    } catch (e) {
      return this._fallo('El modulo serialport no esta instalado.');
    }
    const gen = this._gen = (this._gen || 0) + 1;
    puertos.resolver({
      dueno: this.id,
      cfg: this.config,
      tipo: 'escaner',
      configurados: this._configurados(),
    }).then((r) => {
      if (gen !== this._gen) return;
      if (!r.ruta) return this._fallo(r.error || 'Sin puerto configurado');
      if (r.aviso) console.log(`  [${this.nombre}] ${r.aviso}`);
      this._abrirEn(SerialPort, r.ruta, r.puertos);
    });
  }

  _abrirEn(SerialPort, ruta, vistos) {
    const cfg = this.config;
    this.estado.puerto = ruta;
    let port;
    try {
      port = new SerialPort({
        path: ruta,
        baudRate: Number(cfg.baudRate) || 9600,
        dataBits: Number(cfg.dataBits) || 8,
        parity: cfg.parity || 'none',
        stopBits: Number(cfg.stopBits) || 1,
        autoOpen: false,
      });
    } catch (e) {
      return this._fallo(e.message);
    }
    this._port = port;

    port.open((err) => {
      if (this._detenido || this._port !== port) return;
      if (err) {
        const hay = vistos && vistos.length
          ? ` Puertos en esta PC: ${vistos.join(', ')}.`
          : ' Esta PC no ve ningún puerto COM: ¿el escáner está en modo USB-COM?';
        return this._fallo(`No se pudo abrir ${ruta}: ${err.message}.${hay}`);
      }
      this.estado.conectado = true;
      this.estado.error = null;
      this.emit('estado', this.snapshot());
    });

    port.on('data', (chunk) => { if (this._port === port) this._onData(chunk); });
    port.on('error', (e) => { if (this._port === port) this._fallo(e.message); });
    port.on('close', () => {
      if (this._port !== port) return;
      this.estado.conectado = false;
      this.emit('estado', this.snapshot());
      this._programarReconexion();
    });
  }

  _onData(chunk) {
    this._buffer += chunk.toString('latin1');
    if (this._buffer.length > 1024) this._buffer = this._buffer.slice(-256);
    const partes = this._buffer.split(/[\r\n]+/);
    this._buffer = partes.pop();
    for (const linea of partes) this._emitirCodigo(linea);
  }

  _emitirCodigo(linea) {
    // Algunos escaneres agregan prefijos de control (STX, AIM ID); nos quedamos
    // con lo imprimible.
    const codigo = linea.replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (codigo.length < MIN_LARGO) return;
    this.estado.ultimoCodigo = codigo;
    this.estado.ultimoEn = Date.now();
    this.estado.lecturas++;
    this.emit('codigo', codigo);
    this.emit('estado', this.snapshot());
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

  snapshot() {
    return {
      id: this.id,
      nombre: this.nombre,
      conectado: this.estado.conectado,
      simulador: this.estado.simulador,
      puerto: this.estado.simulador ? 'simulador' : this.estado.puerto,
      error: this.estado.error,
      ultimoCodigo: this.estado.ultimoCodigo,
      ultimoEn: this.estado.ultimoEn,
      lecturas: this.estado.lecturas,
    };
  }
}

module.exports = EscanerDriver;
