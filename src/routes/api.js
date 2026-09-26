'use strict';

/**
 * API REST del punto de venta.
 * Todas las respuestas son JSON. Los precios viajan en centavos.
 */

const express = require('express');
const db = require('../db');
const puertos = require('../puertos');
const { mesValido } = require('../gastos');

module.exports = function crearApi({ estaciones, guardarConfig, config, sheets, gastos, sheetsImportar }) {
  const router = express.Router();

  const ok = (res, data) => res.json({ ok: true, ...data });
  const fallo = (res, code, mensaje) => res.status(code).json({ ok: false, error: mensaje });

  // --- Productos ------------------------------------------------------------

  // Catalogo del POS: solo activos. Es la consulta mas frecuente.
  router.get('/productos', (_req, res) => {
    ok(res, { productos: db.listarProductos(), categorias: db.categorias() });
  });

  // Vista de administracion: incluye los dados de baja.
  router.get('/productos/todos', (_req, res) => {
    ok(res, { productos: db.listarTodosLosProductos() });
  });

  // Busqueda por codigo de barras: el camino del escaner.
  router.get('/productos/codigo/:codigo', (req, res) => {
    const p = db.productoPorCodigo(req.params.codigo.trim());
    if (!p) return fallo(res, 404, 'No hay ningun producto con ese codigo');
    ok(res, { producto: p });
  });

  router.post('/productos', (req, res) => {
    try {
      ok(res, { producto: db.crearProducto(req.body) });
    } catch (e) {
      const dup = /UNIQUE/i.test(e.message);
      fallo(res, 400, dup ? 'Ya existe un producto con ese codigo de barras' : e.message);
    }
  });

  router.put('/productos/:id', (req, res) => {
    try {
      ok(res, { producto: db.actualizarProducto(Number(req.params.id), req.body) });
    } catch (e) {
      const dup = /UNIQUE/i.test(e.message);
      fallo(res, 400, dup ? 'Ya existe un producto con ese codigo de barras' : e.message);
    }
  });

  router.delete('/productos/:id', (req, res) => {
    db.borrarProducto(Number(req.params.id));
    ok(res, {});
  });

  // Importacion masiva desde CSV (una sola transaccion).
  router.post('/productos/importar', (req, res) => {
    try {
      const lista = Array.isArray(req.body.productos) ? req.body.productos : [];
      if (!lista.length) return fallo(res, 400, 'No se recibio ningun producto');
      ok(res, { creados: db.importarProductos(lista) });
    } catch (e) {
      fallo(res, 400, e.message);
    }
  });

  // --- Grupos (categorias) ---------------------------------------------------

  // Solo los activos, en el orden en que quedaron: es la pantalla del POS.
  router.get('/categorias', (_req, res) => {
    ok(res, { categorias: db.categorias() });
  });

  // Vista de administracion: incluye los dados de baja.
  router.get('/categorias/todas', (_req, res) => {
    ok(res, { categorias: db.categoriasTodas() });
  });

  // Nuevo orden despues de arrastrar los grupos. Va declarada antes de /:id
  // para que "orden" no se lea como un id.
  router.put('/categorias/orden', (req, res) => {
    try {
      ok(res, { categorias: db.ordenarCategorias(req.body.ids || []) });
    } catch (e) {
      fallo(res, 400, e.message);
    }
  });

  router.post('/categorias', (req, res) => {
    try {
      ok(res, { categoria: db.crearCategoria(req.body.nombre, req.body.icono) });
    } catch (e) {
      const dup = /UNIQUE/i.test(e.message);
      fallo(res, 400, dup ? 'Ya existe un grupo con ese nombre' : e.message);
    }
  });

  router.put('/categorias/:id', (req, res) => {
    try {
      ok(res, { categoria: db.actualizarCategoria(Number(req.params.id), req.body) });
    } catch (e) {
      const dup = /UNIQUE/i.test(e.message);
      fallo(res, 400, dup ? 'Ya existe un grupo con ese nombre' : e.message);
    }
  });

  router.delete('/categorias/:id', (req, res) => {
    db.borrarCategoria(Number(req.params.id));
    ok(res, {});
  });

  // --- Marcas -----------------------------------------------------------

  // Para el select del alta de producto: solo las activas.
  router.get('/marcas', (_req, res) => {
    ok(res, { marcas: db.listarMarcas() });
  });

  // Vista de administracion: incluye las dadas de baja y cuántos productos usan cada una.
  router.get('/marcas/todas', (_req, res) => {
    ok(res, { marcas: db.listarMarcasTodas() });
  });

  router.post('/marcas', (req, res) => {
    try {
      ok(res, { marca: db.crearMarca(req.body.nombre) });
    } catch (e) {
      const dup = /UNIQUE/i.test(e.message);
      fallo(res, 400, dup ? 'Ya existe una marca con ese nombre' : e.message);
    }
  });

  router.put('/marcas/:id', (req, res) => {
    try {
      ok(res, { marca: db.actualizarMarca(Number(req.params.id), req.body) });
    } catch (e) {
      const dup = /UNIQUE/i.test(e.message);
      fallo(res, 400, dup ? 'Ya existe una marca con ese nombre' : e.message);
    }
  });

  router.delete('/marcas/:id', (req, res) => {
    db.borrarMarca(Number(req.params.id));
    ok(res, {});
  });

  // --- Estaciones, balanzas y escaneres --------------------------------------

  // Lista para que cada equipo de venta elija en que estacion trabaja.
  router.get('/estaciones', (_req, res) => {
    ok(res, { estaciones: estaciones.resumenEstaciones() });
  });

  // Config completa con estado en vivo (administracion).
  router.get('/dispositivos', (_req, res) => {
    ok(res, estaciones.publico());
  });

  // Guarda balanzas, escaneres y estaciones juntos. Solo se reconectan los
  // equipos cuya configuracion cambio.
  router.put('/dispositivos', (req, res) => {
    try {
      const r = estaciones.aplicar(req.body || {});
      guardarConfig(config);
      ok(res, r);
    } catch (e) {
      fallo(res, 400, e.message);
    }
  });

  // Puertos COM de la PC servidor, con numero de serie del adaptador y quien
  // lo usa. El numero de serie es lo que ata cada balanza/escaner a su cable.
  async function listarPuertos(_req, res) {
    try {
      const lista = await puertos.listar();
      const nombres = new Map();
      for (const b of estaciones.lista.balanzas) nombres.set(b.id, b.nombre);
      for (const s2 of estaciones.lista.escaneres) nombres.set(s2.id, s2.nombre);
      ok(res, {
        puertos: lista.map((p) => {
          const dueno = puertos.duenoDe(p.path);
          return { ...p, usadoPor: dueno ? (nombres.get(dueno) || dueno) : null, usadoPorId: dueno };
        }),
      });
    } catch (e) {
      ok(res, { puertos: [], aviso: 'No se pudo listar los puertos: ' + e.message });
    }
  }
  router.get('/puertos', listarPuertos);
  router.get('/balanza/puertos', listarPuertos);

  // Balanza de la peticion: ?balanza=<id> o la de ?estacion=<id>; sin nada, la
  // de la primera estacion (compatibilidad con una sola balanza).
  function balanzaPedida(req) {
    const id = req.query.balanza || (req.body && req.body.balanza);
    if (id) return estaciones.balanza(id);
    const est = req.query.estacion || (req.body && req.body.estacion);
    return estaciones.balanzaDeEstacion(est);
  }

  router.get('/balanza', (req, res) => {
    const b = balanzaPedida(req);
    ok(res, { balanza: b ? b.snapshot() : estaciones.constructor.sinBalanza() });
  });

  // Captura el peso estable actual. El servidor decide si es valido.
  router.post('/balanza/capturar', (req, res) => {
    const b = balanzaPedida(req);
    if (!b) return fallo(res, 409, 'Esta estación no tiene balanza asignada');
    const r = b.capturar();
    if (!r.ok) return fallo(res, 409, r.motivo);
    ok(res, { gramos: r.gramos, balanza: b.id });
  });

  // Tramas crudas: para identificar el protocolo real de la balanza.
  router.get('/balanza/diagnostico', (req, res) => {
    const b = balanzaPedida(req);
    if (!b) return fallo(res, 404, 'No hay balanza');
    ok(res, { tramas: b.tramasCrudas(), estado: b.snapshot() });
  });

  // Peso fijo de prueba (solo en simulador).
  router.post('/balanza/simular', (req, res) => {
    const gramos = Number(req.body.gramos);
    if (!Number.isFinite(gramos) || gramos < 0) return fallo(res, 400, 'Peso invalido');
    const b = balanzaPedida(req);
    if (!b) return fallo(res, 409, 'Esta estación no tiene balanza asignada');
    if (!b.simularPeso(gramos)) return fallo(res, 409, 'La balanza no esta en modo simulador');
    ok(res, { gramos });
  });

  // Cambia la configuracion de UNA balanza (la pedida o la primera).
  router.put('/balanza/config', (req, res) => {
    try {
      const b = balanzaPedida(req);
      if (!b) return fallo(res, 404, 'No hay balanza');
      const cambios = { ...req.body };
      delete cambios.balanza; delete cambios.estacion; delete cambios.id;
      if ('baudRate' in cambios) cambios.baudRate = Number(cambios.baudRate) || 9600;
      if ('simulador' in cambios) cambios.simulador = !!cambios.simulador;
      estaciones.actualizarBalanza(b.id, cambios);
      guardarConfig(config);
      ok(res, { balanza: estaciones.balanza(b.id).snapshot() });
    } catch (e) {
      fallo(res, 400, e.message);
    }
  });

  // Codigo de prueba: como si el escaner de esa estacion lo hubiera leido.
  // Sirve para probar la ruta escaner -> estacion sin el equipo fisico.
  router.post('/escaner/simular', (req, res) => {
    const codigo = String(req.body.codigo || '').trim();
    if (codigo.length < 3) return fallo(res, 400, 'Código inválido');
    let id = req.body.escaner;
    if (!id) {
      const est = estaciones.estacionOPrimera(req.body.estacion);
      id = est && est.escaner;
    }
    const d = id && estaciones.escaner(id);
    if (!d) return fallo(res, 404, 'Esa estación no tiene escáner asignado');
    d.simularCodigo(codigo);
    ok(res, { escaner: id, codigo });
  });

  // --- Ventas ---------------------------------------------------------------

  router.post('/ventas', (req, res) => {
    try {
      const aSheets = !!(sheets && sheets.habilitado());
      // La venta queda marcada con la estacion donde se hizo (snapshot del nombre).
      const est = req.body.estacion ? estaciones.estacion(req.body.estacion) : null;
      const venta = db.guardarVenta(req.body.items || [], {
        sheets: aSheets,
        estacion: est ? { id: est.id, nombre: est.nombre } : null,
      });
      ok(res, { venta });
      if (aSheets) sheets.avisarVentaNueva();
    } catch (e) {
      fallo(res, 400, e.message);
    }
  });

  router.get('/ventas', (req, res) => {
    const limite = Math.min(200, Math.max(1, Number(req.query.limite) || 50));
    ok(res, {
      ventas: db.ventasRecientes(limite),
      resumen: db.resumenDia(),
      porEstacion: db.resumenDiaPorEstacion(),
    });
  });

  // Total vendido por dia (del mes ?mes=AAAA-MM, por defecto el actual) y por
  // mes. Declarada antes de /ventas/:id para que 'totales' no se tome como id.
  router.get('/ventas/totales', (req, res) => {
    ok(res, db.totalesVentas(String(req.query.mes || ''), Number(req.query.meses) || 24));
  });

  // --- Gastos por proveedor (de la planilla de Google) ----------------------

  // ?mes=AAAA-MM (por defecto el actual); ?refrescar=1 saltea la memoria.
  // Nunca falla con 5xx: si Google no responde, devuelve { error } para que
  // administracion lo muestre en el panel sin romper el resto de Ventas.
  router.get('/gastos', async (req, res) => {
    const mesActual = db.hoyLocal().slice(0, 7);
    const mes = mesValido(req.query.mes) ? String(req.query.mes) : mesActual;
    if (!gastos) return ok(res, { gastos: { habilitado: false, mes, motivo: 'No disponible' } });
    const d = await gastos.delMes(mes, { refrescar: req.query.refrescar === '1' });
    ok(res, { gastos: d });
  });

  // --- Copia a Google Sheets (transicion) ----------------------------------

  router.get('/sheets/estado', (_req, res) => {
    ok(res, { sheets: sheets ? sheets.estado() : { habilitado: false } });
  });

  // Fuerza un reintento ya, sin esperar al proximo ciclo.
  router.post('/sheets/reintentar', async (_req, res) => {
    if (!sheets) return fallo(res, 409, 'Sincronizacion con Sheets no disponible');
    await sheets.procesar();
    ok(res, { sheets: sheets.estado() });
  });

  // --- Ventas de la planilla (quienes todavia no usan el POS) ---------------

  router.get('/sheets/importar/estado', (_req, res) => {
    ok(res, { importar: sheetsImportar ? sheetsImportar.estado() : { habilitado: false } });
  });

  // Fuerza una lectura ya, sin esperar al proximo ciclo.
  router.post('/sheets/importar/ahora', async (_req, res) => {
    if (!sheetsImportar) return fallo(res, 409, 'Importacion desde Sheets no disponible');
    await sheetsImportar.procesar();
    ok(res, { importar: sheetsImportar.estado() });
  });

  router.get('/ventas/:id', (req, res) => {
    const venta = db.ventaPorId(Number(req.params.id));
    if (!venta) return fallo(res, 404, 'Venta no encontrada');
    ok(res, { venta });
  });

  return router;
};
