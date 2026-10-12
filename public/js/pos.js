/**
 * Punto de venta - logica de pantalla.
 *
 * La pantalla base es siempre la de GRUPOS (jamones, quesos, gaseosas...).
 *
 * Flujo:
 *   grupo -> producto -> se captura el peso estable -> va al carrito ->
 *   el carrito se muestra unos segundos -> la pantalla vuelve sola a los grupos.
 *   El escaner hace lo mismo sin pasar por los grupos.
 *   La tara se hace en la balanza.
 *
 * Los grupos se acomodan arrastrandolos: manteniendo apretado uno se entra al
 * modo "ordenar" y el orden nuevo se guarda en el servidor.
 *
 * Simulacion de picada: deslizando de derecha a izquierda (o con el boton
 * "Picada") la misma pantalla arma una picada en vez de una venta. Muestra
 * cuanto de cada fiambre y cuanto sale, mas una merma en $ por kg que se cobra
 * segun el peso total. No se guarda en el servidor; la venta abierta queda
 * intacta y se vuelve a ella deslizando al reves.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------- estado

  var estado = {
    productos: [],
    grupos: [],
    carrito: [],
    balanza: { conectado: false, gramos: 0, estable: false, simulador: false },
    filtro: '',
    grupoId: null,
    // Marca elegida dentro del grupo: null = todas (grupo con una sola marca o
    // sin marcas), si no la marca en minusculas. Los productos sin marca se
    // muestran sueltos en la vista de marcas, sin pasar por aca.
    marcaSel: null,
    marcaNombre: '',
    vista: 'grupos',
    ordenando: false,
    // Orden manual de marcas/sueltos/productos: { ambito: { clave: posicion } }.
    orden: {},
    config: { venta: { avisarSiNoTara: true, umbralTaraKg: 0.02, segundosCarrito: 3 } },
    // Para detectar que se peso sin tarar: marcamos si la balanza volvio a cero.
    pasoPorCero: true,
    ultimoPesoCapturado: 0,
    cerrando: false,
    // QR fijo de Mercado Pago: orden viva para el carrito actual ({id, total, firma, timer}).
    qr: null,
    qrDisponible: false,
    qrConsultaMs: 3000,
    qrSync: null,        // timer que espera a que el carrito quede quieto
    qrOcupado: false,    // hay una orden creandose
    qrRepetir: false,
    qrApagado: false,    // QR cancelado a mano en esta venta (vuelve a automatico con la proxima)
    qrPausaFirma: null,  // carrito que no se vuelve a cobrar por QR (ya hubo un pago por otro)
    uid: 1,
    reloj: null,
    tic: null,
    itemConfirmado: null,
    // Hoja del carrito (pantallas angostas)
    hojaAbierta: false,
    relojHoja: null,
    // Estacion de trabajo de este equipo (balanza + escaner asignados).
    estacion: null,
    estaciones: [],
    escaner: null,
    ws: null,
    // ¿Se muestra el boton para leer codigos con la camara? (ver camara.js)
    camara: false,
    // Descuentos disponibles y el aplicado a la venta en curso (uno por venta).
    descuentos: [],
    medios: [],
    descuento: null,
    descTipo: 'porcentaje',
    // venta | picada. La picada tiene su propia lista (no toca el carrito).
    modo: 'venta',
    // mermaKg: centavos por kg de picada; gPersona: gramos por persona.
    picada: { items: [], mermaKg: 0, gPersona: 0 },
  };

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    pesoNumero: $('pesoNumero'),
    chipEstado: $('chipEstado'),
    chipTexto: $('chipTexto'),
    chipPuerto: $('chipPuerto'),
    buscador: $('buscador'),

    vistaGrupos: $('vistaGrupos'),
    vistaMarcas: $('vistaMarcas'),
    vistaProductos: $('vistaProductos'),
    vistaConfirma: $('vistaConfirma'),

    grupos: $('grupos'),
    btnOrdenar: $('btnOrdenar'),
    btnOrdenarTexto: $('btnOrdenarTexto'),
    ordenPanel: $('ordenPanel'),
    columnas: $('columnas'),
    ayudaOrden: $('ayudaOrden'),
    marcas: $('marcas'),
    tituloMarcas: $('tituloMarcas'),
    btnVolverMarcas: $('btnVolverMarcas'),
    btnVolver: $('btnVolver'),
    tituloGrupo: $('tituloGrupo'),
    grilla: $('grilla'),

    confirmaNuevo: $('confirmaNuevo'),
    confirmaNombre: $('confirmaNombre'),
    confirmaDetalle: $('confirmaDetalle'),
    confirmaSubtotal: $('confirmaSubtotal'),
    confirmaLista: $('confirmaLista'),
    confirmaTotal: $('confirmaTotal'),
    btnSeguir: $('btnSeguir'),
    barraTiempo: $('barraTiempo'),

    carritoLista: $('carritoLista'),
    carritoContador: $('carritoContador'),
    total: $('total'),
    btnCobrar: $('btnCobrar'),
    btnCobrarTexto: $('btnCobrarTexto'),
    qrBanda: $('qrBanda'),
    qrMonto: $('qrMonto'),
    qrEstado: $('qrEstado'),
    qrBoton: $('qrBoton'),
    avisos: $('avisos'),

    hoja: $('hoja'),
    hojaFondo: $('hojaFondo'),
    hojaAsa: $('hojaAsa'),
    hojaTiempo: $('hojaTiempo'),
    carritoCab: $('carritoCab'),
    totalMini: $('totalMini'),

    pesoFila: $('pesoFila'),
    chipEstacion: $('chipEstacion'),
    chipEstacionTexto: $('chipEstacionTexto'),
    chipEscaner: $('chipEscaner'),
    selectorEstacion: $('selectorEstacion'),
    selectorLista: $('selectorLista'),
    selectorCerrar: $('selectorCerrar'),

    modalTarjeta: $('modalTarjeta'),
    tarjetaMonto: $('tarjetaMonto'),
    tarjetaVolver: $('tarjetaVolver'),
    tarjetaCobrado: $('tarjetaCobrado'),
    btnTarjeta: $('btnTarjeta'),
    btnTarjetaTexto: $('btnTarjetaTexto'),
    btnDescuento: $('btnDescuento'),
    btnDescuentoTexto: $('btnDescuentoTexto'),
    descuentoMonto: $('descuentoMonto'),
    modalDescuentos: $('modalDescuentos'),
    descuentosLista: $('descuentosLista'),
    descForm: $('descForm'),
    descNombre: $('descNombre'),
    descValor: $('descValor'),
    descTipo: $('descTipo'),
    btnSinDescuento: $('btnSinDescuento'),
    descuentosCerrar: $('descuentosCerrar'),

    carritoTitulo: $('carritoTitulo'),
    ventaPie: $('ventaPie'),
    confirmaTotalRotulo: $('confirmaTotalRotulo'),
    accesoPicada: $('accesoPicada'),
    accesoPicadaTexto: $('accesoPicadaTexto'),
    picadaBanner: $('picadaBanner'),
    btnSalirPicada: $('btnSalirPicada'),
    picadaPanel: $('picadaPanel'),
    picadaItems: $('picadaItems'),
    picadaPie: $('picadaPie'),
    mermaKg: $('mermaKg'),
    mermaDetalle: $('mermaDetalle'),
    mermaTotal: $('mermaTotal'),
    picadaFiambre: $('picadaFiambre'),
    picadaMerma: $('picadaMerma'),
    picadaKg: $('picadaKg'),
    picadaPorKg: $('picadaPorKg'),
    picadaTotal: $('picadaTotal'),
    btnPicadaNueva: $('btnPicadaNueva'),
    gramosPersona: $('gramosPersona'),
    personaDetalle: $('personaDetalle'),
    personasTotal: $('personasTotal'),
    picadaPersonas: $('picadaPersonas'),
  };

  // ---------------------------------------------------------------- formato

  var fmtPesos = new Intl.NumberFormat('es-AR', {
    style: 'currency', currency: 'ARS', minimumFractionDigits: 2,
  });

  function plata(centavos) { return fmtPesos.format((centavos || 0) / 100); }
  // Coma decimal, como se escribe acá.
  function kg(gramos) { return (gramos / 1000).toFixed(3).replace('.', ','); }

  // ---------------------------------------------------------------- avisos

  function avisar(texto, tipo, accion) {
    var div = document.createElement('div');
    div.className = 'aviso ' + (tipo || '');

    var span = document.createElement('div');
    span.className = 'aviso-texto';
    span.textContent = texto;
    div.appendChild(span);

    if (accion) {
      var btn = document.createElement('button');
      btn.className = 'aviso-accion';
      btn.textContent = accion.texto;
      btn.addEventListener('click', function () {
        accion.fn();
        quitar();
      });
      div.appendChild(btn);
    }

    el.avisos.appendChild(div);

    var t = setTimeout(quitar, accion ? 8000 : 2600);
    function quitar() {
      clearTimeout(t);
      if (div.parentNode) div.parentNode.removeChild(div);
    }
  }

  // ---------------------------------------------------------------- balanza

  function pintarBalanza() {
    var b = estado.balanza;
    el.pesoNumero.textContent = kg(b.gramos || 0);

    var clase = 'peso-numero num ';
    if (!b.conectado) clase += 'sin-conexion';
    else if (b.estable) clase += 'estable';
    else clase += 'inestable';
    el.pesoNumero.className = clase;

    var chipClase, texto;
    if (b.sinBalanza) { chipClase = 'chip'; texto = 'Sin balanza'; }
    else if (!b.conectado) { chipClase = 'chip mal'; texto = b.error ? 'Balanza desconectada' : 'Sin balanza'; }
    else if (b.estable) { chipClase = 'chip ok'; texto = 'Peso estable'; }
    else { chipClase = 'chip espera'; texto = 'Estabilizando…'; }
    el.chipEstado.className = chipClase;
    el.chipTexto.textContent = texto;

    if (b.conectado) {
      el.chipPuerto.hidden = false;
      var quien = varias() && b.nombre ? b.nombre + ' · ' : '';
      el.chipPuerto.textContent = quien + (b.simulador
        ? 'Modo simulador'
        : b.puerto + ' · ' + (b.protocolo || 'auto'));
    } else {
      el.chipPuerto.hidden = !b.error;
      el.chipPuerto.textContent = b.error || '';
    }


    // Si la balanza volvio a (casi) cero, la tara esta hecha.
    var umbral = Math.round((estado.config.venta.umbralTaraKg || 0.02) * 1000);
    if (b.gramos <= umbral) estado.pasoPorCero = true;
  }

  function conectarWS() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    var q = estado.estacion ? '?estacion=' + encodeURIComponent(estado.estacion) : '';
    var ws = new WebSocket(proto + '://' + location.host + '/ws' + q);
    estado.ws = ws;

    ws.onmessage = function (ev) {
      if (estado.ws !== ws) return;
      var msg = JSON.parse(ev.data);
      if (msg.tipo === 'balanza') {
        estado.balanza = msg.estado;
        pintarBalanza();
      } else if (msg.tipo === 'escaner') {
        estado.escaner = msg.estado;
        pintarEstacion();
      } else if (msg.tipo === 'escaneo') {
        porCodigo(msg.codigo);
      } else if (msg.tipo === 'estacion') {
        recibirEstacion(msg.estacion);
      } else if (msg.tipo === 'version') {
        recibirVersion(msg.version);
      }
    };

    // Al (re)conectar el servidor no sabe cuantos articulos hay en este carrito.
    ws.onopen = function () { informarCarrito(true); };

    ws.onclose = function () {
      // Un socket reemplazado a proposito (cambio de estacion) no reconecta.
      if (estado.ws !== ws) return;
      estado.balanza.conectado = false;
      pintarBalanza();
      setTimeout(function () { if (estado.ws === ws) conectarWS(); }, 2000);
    };

    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  function reconectarWS() {
    var viejo = estado.ws;
    estado.ws = null;
    if (viejo) { try { viejo.close(); } catch (e) {} }
    conectarWS();
  }

  // Avisa al servidor que este equipo se esta usando: el escaner de la estacion
  // le manda los codigos al ultimo equipo usado (si hay dos en el mismo puesto,
  // el producto no se agrega dos veces).
  var ultimoActivo = 0;
  function marcarActivo() {
    var ahora = Date.now();
    ultimoToque = ahora;
    if (ahora - ultimoActivo < 3000) return;
    ultimoActivo = ahora;
    var ws = estado.ws;
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ tipo: 'activo' })); } catch (e) {}
    }
  }

  // ---------------------------------------------------------------- version

  // El actualizador automatico reinicia el servidor con una version nueva. La
  // pantalla se recarga sola para tomar el HTML/JS nuevo, pero solo con el
  // carrito vacio y sin que nadie la haya tocado en los ultimos 20 segundos.
  var ultimoToque = Date.now();
  function recibirVersion(v) {
    if (!v) return;
    if (!estado.version) { estado.version = v; return; }
    if (v !== estado.version) {
      estado.versionNueva = v;
      recargarSiLibre();
    }
  }

  function recargarSiLibre() {
    if (!estado.versionNueva) return;
    var libre = !estado.carrito.length && !estado.picada.items.length && !estado.cerrando && Date.now() - ultimoToque > 20000;
    if (libre) { location.reload(); return; }
    clearTimeout(estado.relojVersion);
    estado.relojVersion = setTimeout(recargarSiLibre, 10000);
  }

  // Le cuenta al servidor cuantos articulos hay en el carrito de este equipo:
  // el actualizador no reinicia el POS mientras alguno tenga una venta a medias.
  var itemsInformados = -1;
  function informarCarrito(forzar) {
    var n = estado.carrito.length;
    if (!forzar && n === itemsInformados) return;
    var ws = estado.ws;
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ tipo: 'carrito', items: n })); itemsInformados = n; } catch (e) {}
    }
  }

  // ---------------------------------------------------------------- estacion

  var CLAVE_ESTACION = 'pos.estacion';

  function leerEstacionGuardada() {
    try { return localStorage.getItem(CLAVE_ESTACION); } catch (e) { return null; }
  }

  function guardarEstacion(id) {
    try { localStorage.setItem(CLAVE_ESTACION, id); } catch (e) {}
  }

  function varias() { return estado.estaciones.length > 1; }

  function estacionPorId(id) {
    for (var i = 0; i < estado.estaciones.length; i++) {
      if (estado.estaciones[i].id === id) return estado.estaciones[i];
    }
    return null;
  }

  /** ?estacion=<id> para las llamadas que dependen de la balanza. */
  function qEstacion() {
    return estado.estacion ? '?estacion=' + encodeURIComponent(estado.estacion) : '';
  }

  function pintarEstacion() {
    var e = estacionPorId(estado.estacion);
    el.chipEstacion.hidden = !varias() || !e;
    if (e) el.chipEstacionTexto.textContent = e.nombre;

    var s = estado.escaner;
    if (s && e && e.escaner) {
      el.chipEscaner.hidden = false;
      el.chipEscaner.className = 'chip ' + (s.conectado ? 'ok' : 'mal');
      el.chipEscaner.textContent = s.conectado
        ? (s.simulador ? 'Escáner (simulador)' : 'Escáner listo')
        : 'Escáner desconectado';
      el.chipEscaner.title = s.error || s.puerto || '';
    } else {
      el.chipEscaner.hidden = true;
    }
    el.pesoFila.hidden = el.chipEstacion.hidden && el.chipEscaner.hidden;
  }

  function cargarEstaciones() {
    return fetch('/api/estaciones')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error);
        estado.estaciones = d.estaciones || [];
        return estado.estaciones;
      });
  }

  /** Elige la estacion al arrancar: la guardada, la unica, o se pregunta. */
  function decidirEstacion() {
    var guardada = leerEstacionGuardada();
    if (guardada && estacionPorId(guardada)) return usarEstacion(guardada, false);
    if (estado.estaciones.length === 1) return usarEstacion(estado.estaciones[0].id, false);
    if (!estado.estaciones.length) { conectarWS(); return; }
    abrirSelector(false);
  }

  function usarEstacion(id, avisarCambio) {
    var cambio = estado.estacion !== id;
    // La primera eleccion no es un "cambio" para avisar.
    if (!estado.estacion) avisarCambio = false;
    estado.estacion = id;
    guardarEstacion(id);
    cerrarSelector();
    // La balanza cambia: el control de tara empieza de nuevo.
    if (cambio) {
      estado.pasoPorCero = true;
      estado.ultimoPesoCapturado = 0;
      estado.escaner = null;
    }
    pintarEstacion();
    if (cambio || !estado.ws) reconectarWS();
    if (cambio && avisarCambio) {
      var e = estacionPorId(id);
      avisar('Este equipo ahora trabaja en ' + (e ? e.nombre : id), 'ok');
    }
  }

  /** El servidor confirma la estacion; si la nuestra ya no existe, se vuelve a elegir. */
  function recibirEstacion(e) {
    cargarEstaciones().then(function () {
      if (e && e.id === estado.estacion) { pintarEstacion(); return; }
      if (estado.estaciones.length > 1) {
        avisar('La estación de este equipo ya no existe: elegí una.', 'atencion');
        abrirSelector(false);
      } else if (e) {
        usarEstacion(e.id, false);
      }
    }).catch(function () {});
  }

  function abrirSelector(cancelable) {
    var lista = el.selectorLista;
    lista.innerHTML = '';
    estado.estaciones.forEach(function (e) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'selector-opcion' + (e.id === estado.estacion ? ' actual' : '');
      b.dataset.id = e.id;
      var n = document.createElement('span');
      n.className = 'selector-nombre';
      n.textContent = e.nombre;
      var eq = document.createElement('span');
      eq.className = 'selector-equipos';
      eq.textContent =
        '⚖️ ' + (e.balanzaNombre || 'sin balanza') + '   ·   ' +
        '▥ ' + (e.escanerNombre || 'sin escáner');
      b.appendChild(n);
      b.appendChild(eq);
      b.addEventListener('click', function () { usarEstacion(e.id, true); });
      lista.appendChild(b);
    });
    el.selectorCerrar.hidden = !cancelable || !estado.estacion;
    el.selectorEstacion.hidden = false;
  }

  function cerrarSelector() { el.selectorEstacion.hidden = true; }

  // ---------------------------------------------------------------- vistas

  /** grupos | marcas | productos | confirma. Salir de "confirma" corta la vuelta automatica. */
  function mostrarVista(cual) {
    if (cual !== 'confirma') cancelarReloj();
    estado.vista = cual;
    el.vistaGrupos.hidden = cual !== 'grupos';
    el.vistaMarcas.hidden = cual !== 'marcas';
    el.vistaProductos.hidden = cual !== 'productos';
    el.vistaConfirma.hidden = cual !== 'confirma';
  }

  function volverAGrupos() {
    if (estado.filtro) {
      el.buscador.value = '';
      estado.filtro = '';
    }
    estado.grupoId = null;
    estado.marcaSel = null;
    estado.itemConfirmado = null;
    modoOrdenar(false);
    mostrarVista('grupos');
  }

  /**
   * Un grupo con 2 o mas marcas abre primero las marcas; con una sola (o sin
   * marcas) va directo a los productos, que seria un toque de mas.
   */
  function abrirGrupo(id) {
    estado.grupoId = id;
    estado.marcaSel = null;
    if (hayVistaMarcas(marcasDelGrupo())) {
      mostrarVista('marcas');
      pintarMarcas();
    } else {
      mostrarVista('productos');
      pintarGrilla();
    }
  }

  function abrirMarca(m) {
    estado.marcaSel = m.clave;
    estado.marcaNombre = m.nombre;
    mostrarVista('productos');
    pintarGrilla();
  }

  /** Atras desde los productos: a las marcas si se vino de ahi, si no a los grupos. */
  function volverDeProductos() {
    modoOrdenar(false);
    if (!estado.filtro.trim() && estado.marcaSel !== null) {
      estado.marcaSel = null;
      mostrarVista('marcas');
      pintarMarcas();
    } else {
      volverAGrupos();
    }
  }

  function claveMarca(p) { return (p.marca || '').trim().toLowerCase(); }

  /** Un producto va suelto (sin pasar por una marca) si no tiene marca o se la sacaron. */
  function vaSuelto(p) { return !claveMarca(p) || p.agrupar_marca === 0; }

  /**
   * Marcas del grupo abierto (con su cuenta) y los productos sueltos, que se
   * muestran al lado de las marcas. `items` los junta en el orden elegido a mano
   * (lo no acomodado queda al final: marcas A-Z y despues los sueltos). Un solo recorrido.
   */
  function marcasDelGrupo() {
    var mapa = {}, marcas = [], sueltos = [];
    for (var i = 0; i < estado.productos.length; i++) {
      var p = estado.productos[i];
      if (p.categoria_id !== estado.grupoId) continue;
      if (vaSuelto(p)) { sueltos.push(p); continue; }
      var k = claveMarca(p);
      var m = mapa[k];
      if (!m) {
        m = mapa[k] = { clave: k, nombre: p.marca.trim(), productos: 0 };
        marcas.push(m);
      }
      m.productos++;
    }
    marcas.sort(function (a, b) { return a.nombre.localeCompare(b.nombre, 'es'); });
    var items = marcas.map(function (m) { return { clave: 'm:' + m.clave, marca: m }; })
      .concat(sueltos.map(function (p) { return { clave: 'p:' + p.id, p: p }; }));
    items = ordenarPor(items, ambitoGrupo(), function (it) { return it.clave; });
    return { marcas: marcas, sueltos: sueltos, items: items };
  }

  /** Marcas: con 2 o mas, o con una y productos sueltos que mostrar al lado. */
  function hayVistaMarcas(mg) {
    return mg.marcas.length > 1 || (mg.marcas.length === 1 && mg.sueltos.length > 0);
  }

  /** Acomoda `lista` segun el orden guardado de `ambito`; lo no acomodado queda al final, como venia. */
  function ordenarPor(lista, ambito, claveDe) {
    var m = ambito && estado.orden[ambito];
    if (!m) return lista;
    return lista.map(function (x, i) { return { x: x, i: i, o: m[claveDe(x)] || 0 }; })
      .sort(function (a, b) {
        if (a.o && b.o) return a.o - b.o;
        if (a.o) return -1;
        if (b.o) return 1;
        return a.i - b.i;
      })
      .map(function (r) { return r.x; });
  }

  function ambitoGrupo() { return estado.grupoId == null ? null : 'g:' + estado.grupoId; }

  /** Donde se guarda el orden de la grilla de productos (null = buscador, no se acomoda). */
  function ambitoProductos() {
    if (estado.filtro.trim() || estado.grupoId == null) return null;
    var marca = estado.marcaSel;
    if (marca === null) {
      // Grupo con una sola marca y nada suelto: la grilla ES esa marca.
      var mg = marcasDelGrupo();
      if (mg.marcas.length === 1 && !mg.sueltos.length) marca = mg.marcas[0].clave;
    }
    return marca !== null ? 'm:' + estado.grupoId + ':' + marca : 'g:' + estado.grupoId;
  }

  /** Saca el producto de su marca (queda suelto en el grupo) o lo vuelve a meter. */
  function cambiarAgrupar(p) {
    var antes = p.agrupar_marca === 0 ? 0 : 1;
    p.agrupar_marca = antes ? 0 : 1;
    reabrirGrupo();
    fetch('/api/productos/' + p.id + '/agrupar', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agrupar: p.agrupar_marca === 1 }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d.ok) throw new Error(d.error); })
      .catch(function (e) {
        p.agrupar_marca = antes;
        reabrirGrupo();
        avisar('No se pudo guardar: ' + e.message, 'error');
      });
  }

  /** Repinta la pantalla del grupo abierto despues de cambiar que va suelto (el modo ordenar sigue). */
  function reabrirGrupo() {
    if (estado.grupoId == null) return;
    var mg = marcasDelGrupo();
    if (estado.vista === 'productos' && estado.marcaSel !== null) {
      var sigue = mg.marcas.some(function (m) { return m.clave === estado.marcaSel; });
      if (sigue) { pintarGrilla(); return; }
      estado.marcaSel = null;   // la marca se quedo sin productos
    }
    if (hayVistaMarcas(mg)) { mostrarVista('marcas'); pintarMarcas(); }
    else { mostrarVista('productos'); pintarGrilla(); }
  }

  // ---------------------------------------------------------------- catalogo

  function cargarCatalogo() {
    return fetch('/api/productos')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error);
        estado.productos = d.productos;
        estado.grupos = d.categorias || [];
        estado.orden = d.orden || {};
        // Si el grupo que estaba abierto se dio de baja, volvemos a la base.
        if (estado.grupoId && !grupoPorId(estado.grupoId)) {
          estado.grupoId = null;
          estado.marcaSel = null;
          if (estado.vista === 'marcas' || (estado.vista === 'productos' && !estado.filtro.trim())) mostrarVista('grupos');
        }
        pintarGrupos();
        if (estado.vista === 'marcas') pintarMarcas();
        if (estado.vista === 'productos') pintarGrilla();
      })
      .catch(function (e) { avisar('No se pudieron cargar los productos: ' + e.message, 'error'); });
  }

  function grupoPorId(id) {
    for (var i = 0; i < estado.grupos.length; i++) {
      if (estado.grupos[i].id === id) return estado.grupos[i];
    }
    return null;
  }

  function pintarGrupos() {
    el.grupos.innerHTML = '';

    if (!estado.grupos.length) {
      var v = document.createElement('div');
      v.className = 'vacio';
      v.textContent = 'Todavía no hay grupos cargados. Entrá a Administrar para crearlos.';
      el.grupos.appendChild(v);
      return;
    }

    var frag = document.createDocumentFragment();
    estado.grupos.forEach(function (g) {
      var b = document.createElement('button');
      b.className = 'grupo';
      b.dataset.id = g.id;

      var ico = document.createElement('div');
      ico.className = 'grupo-icono';
      ico.setAttribute('aria-hidden', 'true');
      ico.textContent = g.icono || '📦';

      var nom = document.createElement('div');
      nom.className = 'grupo-nombre';
      nom.textContent = g.nombre;

      var n = document.createElement('div');
      n.className = 'grupo-cuenta';
      n.textContent = g.productos === 1 ? '1 producto' : g.productos + ' productos';

      b.appendChild(ico);
      b.appendChild(nom);
      b.appendChild(n);
      b.addEventListener('click', function () {
        if (estado.ordenando) return;   // en modo ordenar, tocar no abre el grupo
        abrirGrupo(g.id);
      });
      frag.appendChild(b);
    });
    el.grupos.appendChild(frag);
  }

  function pintarMarcas() {
    var grupo = grupoPorId(estado.grupoId);
    el.tituloMarcas.textContent = grupo ? grupo.nombre : 'Marcas';
    el.marcas.innerHTML = '';
    var frag = document.createDocumentFragment();
    var mg = marcasDelGrupo();
    mg.items.forEach(function (it) {
      // Productos sueltos (sin marca o sacados de ella): listos para tocar.
      if (!it.marca) { frag.appendChild(tileProducto(it.p)); return; }
      var m = it.marca;
      var b = document.createElement('button');
      b.className = 'marca-tile';
      b.dataset.marca = m.clave;
      b.dataset.clave = it.clave;

      var nom = document.createElement('div');
      nom.className = 'marca-nombre';
      nom.textContent = m.nombre;

      var n = document.createElement('div');
      n.className = 'marca-cuenta';
      n.textContent = m.productos === 1 ? '1 producto' : m.productos + ' productos';

      b.appendChild(nom);
      b.appendChild(n);
      b.addEventListener('click', function () {
        if (estado.ordenando) return;   // en modo ordenar, tocar no abre la marca
        abrirMarca(m);
      });
      frag.appendChild(b);
    });
    el.marcas.appendChild(frag);
  }

  function abrirCamara() {
    if (estado.ordenando || !window.Camara) return;
    window.Camara.abrir({
      alLeer: porCodigo,
      alError: function (texto, accion) {
        // Pasar a https recarga la pagina: con una venta a medio cargar, no.
        if (accion && (estado.carrito.length || estado.cerrando)) {
          avisar(texto + ' Cerrá la venta abierta antes de cambiar.', 'atencion');
          return;
        }
        // Mensajes largos: con boton quedan 8 s en pantalla en vez de 2,6.
        avisar(texto, accion ? 'atencion' : 'error', accion || { texto: 'Entendido', fn: function () {} });
      },
    });
  }

  function decidirCamara() {
    if (!window.Camara) return;
    window.Camara.hayCamara().then(function (si) {
      if (si === estado.camara) return;
      estado.camara = si;
      textoAyudaGrupos();
    });
  }

  // ------------------------------------------------------- columnas de grupos
  // Cada equipo (tablet, celular, PC) elige cuantas columnas de grupos quiere;
  // se recuerda en ese navegador. "auto" reparte segun el ancho de la pantalla.
  var CLAVE_COLUMNAS = 'pos.columnasGrupos';

  function leerColumnas() {
    try { return localStorage.getItem(CLAVE_COLUMNAS) || 'auto'; } catch (e) { return 'auto'; }
  }

  function aplicarColumnas(valor) {
    var n = parseInt(valor, 10);
    var fijo = n >= 1 && n <= 6;
    el.grupos.style.gridTemplateColumns = fijo ? 'repeat(' + n + ', minmax(0, 1fr))' : '';
    el.grupos.dataset.columnas = fijo ? String(n) : 'auto';
    if (el.columnas) {
      el.columnas.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('activo', b.dataset.col === (fijo ? String(n) : 'auto'));
      });
    }
  }

  function elegirColumnas(valor) {
    try { localStorage.setItem(CLAVE_COLUMNAS, valor); } catch (e) {}
    aplicarColumnas(valor);
  }

  function productosVisibles() {
    var f = estado.filtro.toLowerCase().trim();
    return estado.productos.filter(function (p) {
      if (f) return (p.nombre + ' ' + p.marca + ' ' + (p.sabor || '') + ' ' + (p.contenido || '') + ' ' + p.categoria).toLowerCase().indexOf(f) !== -1;
      if (p.categoria_id !== estado.grupoId) return false;
      return estado.marcaSel === null || (claveMarca(p) === estado.marcaSel && p.agrupar_marca !== 0);
    });
  }

  /** Boton de un producto (grilla de productos y sueltos de la vista de marcas). */
  function tileProducto(p) {
    var b = document.createElement('button');
    b.className = 'prod';

    var arriba = document.createElement('div');
    var nom = document.createElement('div');
    nom.className = 'prod-nombre';
    nom.textContent = p.nombre;
    arriba.appendChild(nom);

    var sub = [p.marca, p.sabor, p.contenido].filter(Boolean).join(' · ');
    if (sub) {
      var ma = document.createElement('div');
      ma.className = 'prod-marca';
      ma.textContent = sub;
      arriba.appendChild(ma);
    }

    var pie = document.createElement('div');
    pie.className = 'prod-pie';
    var pr = document.createElement('span');
    pr.className = 'prod-precio num';
    pr.textContent = plata(p.precio_centavos);
    var un = document.createElement('span');
    un.className = 'prod-unidad';
    un.textContent = p.tipo === 'peso' ? '/ kg' : 'c/u';
    pie.appendChild(pr);
    pie.appendChild(un);

    b.appendChild(arriba);
    b.appendChild(pie);
    b.dataset.clave = 'p:' + p.id;
    // Solo se ve en modo ordenar: sacar el producto de su marca o volver a meterlo.
    if (claveMarca(p)) {
      var ag = document.createElement('span');
      ag.className = 'prod-agrupar';
      ag.setAttribute('role', 'button');
      ag.textContent = p.agrupar_marca === 0 ? 'Meter en la marca' : 'Sacar de la marca';
      ag.addEventListener('click', function (e) { e.stopPropagation(); cambiarAgrupar(p); });
      b.appendChild(ag);
    }
    b.addEventListener('click', function () {
      if (estado.ordenando) return;   // en modo ordenar, tocar no agrega
      agregarProducto(p);
    });
    return b;
  }

  function pintarGrilla() {
    var lista = productosVisibles();
    var amb = ambitoProductos();
    if (amb) lista = ordenarPor(lista, amb, function (p) { return 'p:' + p.id; });
    var grupo = grupoPorId(estado.grupoId);

    var conMarca = !estado.filtro.trim() && estado.marcaSel !== null;
    el.tituloGrupo.textContent = estado.filtro.trim()
      ? 'Resultados de “' + estado.filtro.trim() + '”'
      : (grupo ? grupo.nombre : 'Productos') + (conMarca ? ' · ' + estado.marcaNombre : '');
    el.btnVolver.textContent = conMarca ? '‹ Marcas' : '‹ Grupos';

    el.grilla.innerHTML = '';

    if (!lista.length) {
      var v = document.createElement('div');
      v.className = 'vacio';
      v.textContent = estado.filtro.trim()
        ? 'No hay productos que coincidan.'
        : 'Este grupo todavía no tiene productos.';
      el.grilla.appendChild(v);
      return;
    }

    var frag = document.createDocumentFragment();
    lista.forEach(function (p) { frag.appendChild(tileProducto(p)); });
    el.grilla.appendChild(frag);
  }

  // ------------------------------------------------------- ordenar grupos

  /**
   * Arrastrar para acomodar los grupos.
   *
   * Se entra al modo con el boton Ordenar (asi no se desacomodan solos mientras
   * se vende; mantener apretado esta reservado para escanear). Dentro del modo,
   * el arrastre arranca apenas se toca y los grupos dejan de tomar el gesto de
   * scroll (touch-action), que es lo que en una tablet corta el arrastre por la
   * mitad.
   */
  function modoOrdenar(activo) {
    estado.ordenando = !!activo;
    el.grupos.classList.toggle('ordenando', estado.ordenando);
    el.marcas.classList.toggle('ordenando', estado.ordenando);
    el.grilla.classList.toggle('ordenando', estado.ordenando);
    el.btnOrdenarTexto.textContent = estado.ordenando ? 'Finalizar' : 'Ordenar';
    el.btnOrdenar.classList.toggle('activo', estado.ordenando);
    el.ordenPanel.hidden = !estado.ordenando;
    textoAyudaGrupos();
  }

  function textoAyudaGrupos() {
    el.ayudaOrden.textContent = estado.ordenando
      ? 'Arrastrá los grupos para acomodarlos'
      : (estado.camara ? 'Mantené apretada la pantalla para escanear' : '');
    document.querySelectorAll('.ayuda-ordenar').forEach(function (n) {
      n.textContent = 'Arrastrá para acomodar · el botón de cada artículo lo saca o lo mete en su marca';
      n.hidden = !estado.ordenando;
    });
  }

  var SEL_TILE = '.grupo, .marca-tile, .prod';

  function habilitarArrastre() {
    var arr = null;       // arrastre en curso
    var hueco = null;     // lugar que va a ocupar al soltar

    function ubicar(x, y) {
      arr.tile.style.transform =
        'translate(' + (x - arr.dx) + 'px,' + (y - arr.dy) + 'px) scale(1.04)';
    }

    function iniciar(cont, tile, e) {
      var r = tile.getBoundingClientRect();
      arr = { cont: cont, tile: tile, dx: e.clientX - r.left, dy: e.clientY - r.top };

      hueco = document.createElement('div');
      hueco.className = (tile.classList.contains('grupo') ? 'grupo' :
        tile.classList.contains('marca-tile') ? 'marca-tile' : 'prod') + ' hueco';
      hueco.style.minHeight = r.height + 'px';
      cont.insertBefore(hueco, tile);

      tile.classList.add('arrastrando');
      tile.style.position = 'fixed';
      tile.style.left = '0';
      tile.style.top = '0';
      tile.style.width = r.width + 'px';
      tile.style.height = r.height + 'px';
      tile.style.pointerEvents = 'none';
      ubicar(e.clientX, e.clientY);

      try { cont.setPointerCapture(e.pointerId); } catch (err) {}
    }

    function mover(e) {
      ubicar(e.clientX, e.clientY);

      var bajo = document.elementFromPoint(e.clientX, e.clientY);
      var destino = bajo && bajo.closest ? bajo.closest(SEL_TILE) : null;
      if (!destino || destino === hueco || destino === arr.tile || destino.parentNode !== arr.cont) return;

      var r = destino.getBoundingClientRect();
      var antes = e.clientX < r.left + r.width / 2;
      arr.cont.insertBefore(hueco, antes ? destino : destino.nextSibling);
    }

    function soltar() {
      if (!arr) return;
      var tile = arr.tile;
      tile.classList.remove('arrastrando');
      tile.removeAttribute('style');
      if (hueco && hueco.parentNode) hueco.parentNode.replaceChild(tile, hueco);
      hueco = null;
      arr = null;
      guardarOrden();
    }

    // Los grupos, las marcas (con sus sueltos) y la grilla de productos se acomodan igual.
    [el.grupos, el.marcas, el.grilla].forEach(function (cont) {
      cont.addEventListener('pointerdown', function (e) {
        if (!estado.ordenando || arr) return;
        if (e.target.closest && e.target.closest('.prod-agrupar')) return;   // ese es un toque, no un arrastre
        var tile = e.target.closest ? e.target.closest(SEL_TILE) : null;
        if (!tile || tile.classList.contains('hueco') || tile.parentNode !== cont) return;
        iniciar(cont, tile, e);
      });

      cont.addEventListener('pointermove', function (e) {
        if (arr && arr.cont === cont) mover(e);
      });

      cont.addEventListener('pointerup', function () { if (arr && arr.cont === cont) soltar(); });
      cont.addEventListener('pointercancel', function () { if (arr && arr.cont === cont) soltar(); });
    });
  }

  function guardarOrden() {
    if (estado.vista !== 'grupos') { guardarOrdenVista(); return; }

    var ids = [];
    el.grupos.querySelectorAll('.grupo').forEach(function (n) {
      if (n.dataset.id) ids.push(Number(n.dataset.id));
    });
    if (!ids.length) return;

    // Ordenamos tambien el estado local: la tablet ya muestra el orden nuevo y
    // no depende de la respuesta del servidor para seguir vendiendo.
    estado.grupos.sort(function (a, b) { return ids.indexOf(a.id) - ids.indexOf(b.id); });

    fetch('/api/categorias/orden', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d.ok) throw new Error(d.error); })
      .catch(function (e) { avisar('No se pudo guardar el orden: ' + e.message, 'error'); });
  }

  /** Orden de las marcas/sueltos de un grupo o de los productos de una marca (todo el ambito de una vez). */
  function guardarOrdenVista() {
    var cont = estado.vista === 'marcas' ? el.marcas : el.grilla;
    var ambito = estado.vista === 'marcas' ? ambitoGrupo() : ambitoProductos();
    if (!ambito) return;
    var claves = [], mapa = {};
    cont.querySelectorAll(SEL_TILE).forEach(function (n) {
      if (n.dataset.clave && !n.classList.contains('hueco')) claves.push(n.dataset.clave);
    });
    if (!claves.length) return;
    claves.forEach(function (c, i) { mapa[c] = i + 1; });
    estado.orden[ambito] = mapa;

    fetch('/api/orden-vista', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ambito: ambito, claves: claves }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d.ok) throw new Error(d.error); })
      .catch(function (e) { avisar('No se pudo guardar el orden: ' + e.message, 'error'); });
  }

  // ---------------------------------------------------------------- carrito

  // Pesables: redondeo SIEMPRE para arriba a multiplo de $100 (6215 -> 6300).
  // Misma regla que subtotalPesable() en src/db.js (el servidor es el que manda).
  var REDONDEO_PESABLE = 10000; // centavos

  function subtotalDe(item) {
    return item.tipo === 'peso'
      ? Math.ceil((item.cantidad * item.precio_centavos) / (1000 * REDONDEO_PESABLE)) * REDONDEO_PESABLE
      : item.cantidad * item.precio_centavos;
  }

  function totalBruto() {
    return estado.carrito.reduce(function (a, i) { return a + subtotalDe(i); }, 0);
  }

  // Igual que montoDescuento() en src/db.js: pesos enteros, tope el total.
  function descuentoDe(d, bruto) {
    if (!d) return 0;
    var m = d.tipo === 'porcentaje' ? Math.round((bruto * d.valor) / 10000) * 100 : d.valor;
    return Math.min(bruto, Math.max(0, m));
  }

  function totalCarrito() {
    var bruto = totalBruto();
    return bruto - descuentoDe(estado.descuento, bruto);
  }

  // Medios de pago (los porcentajes vienen de /api/medios-pago). Misma regla que
  // totalConMedio() en src/db.js: neto + bp (1 % = 100), para arriba a multiplo de $100.
  function totalConMedio(neto, bp) {
    if (neto <= 0 || bp <= 0) return neto;
    return Math.floor((neto * (10000 + bp) + 99999999) / 100000000) * 10000;
  }

  function pintarMedios() {
    var neto = totalCarrito();
    var hay = estado.medios.length > 0 && neto > 0;
    el.btnTarjeta.hidden = true; // boton de tarjeta fuera de la pantalla de cobro
    el.btnTarjeta.disabled = !hay || estado.cerrando;
    if (!hay) { cerrarTarjeta(); return; }
    var tarjeta = plata(totalConMedio(neto, medioBp('tarjeta')));
    el.tarjetaMonto.textContent = tarjeta;
    if (!estado.cerrando) el.btnTarjetaTexto.textContent = 'Tarjeta · ' + tarjeta;
  }

  /** Cobro con tarjeta: pantalla con el monto grande para el cliente; "Cobrado" guarda la venta. */
  function abrirTarjeta() {
    if (!estado.carrito.length || estado.cerrando) return;
    pintarMedios();
    el.modalTarjeta.hidden = false;
  }

  function cerrarTarjeta() { el.modalTarjeta.hidden = true; }

  function medioBp(clave) {
    var m = estado.medios.filter(function (x) { return x.clave === clave; })[0];
    return m ? m.bp : 0;
  }

  function textoDescuento(d) {
    return d.tipo === 'porcentaje' ? d.valor + '%' : plata(d.valor);
  }

  function detalleDe(item) {
    return item.tipo === 'peso'
      ? kg(item.cantidad) + ' kg × ' + plata(item.precio_centavos) + '/kg'
      : item.cantidad + ' × ' + plata(item.precio_centavos);
  }

  function agregarProducto(p) {
    if (p.tipo === 'unidad') return agregarUnidad(p);
    return agregarPorPeso(p);
  }

  function agregarUnidad(p) {
    var destino = lista();
    // Si ya esta en el carrito, sumamos una unidad en vez de duplicar la linea.
    var existente = null;
    for (var i = 0; i < destino.length; i++) {
      if (destino[i].producto_id === p.id && destino[i].tipo === 'unidad') {
        existente = destino[i];
        break;
      }
    }
    if (existente) existente.cantidad += 1;
    else {
      existente = {
        uid: estado.uid++,
        producto_id: p.id,
        nombre: p.nombre,
        marca: p.marca,
        tipo: 'unidad',
        cantidad: 1,
        precio_centavos: p.precio_centavos,
      };
      destino.push(existente);
    }
    pintarDe(destino);
    mostrarConfirmacion(existente);
  }

  function agregarPorPeso(p) {
    // Venta o picada: se decide al tocar, no cuando contesta la balanza.
    var modo = estado.modo;
    // El servidor valida estabilidad y peso minimo: no confiamos en la pantalla.
    fetch('/api/balanza/capturar' + qEstacion(), { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          avisar(d.error, 'atencion');
          return;
        }

        var gramos = d.gramos;
        var anterior = estado.ultimoPesoCapturado;

        // Si la balanza nunca volvio a cero, lo mas probable es que no se
        // haya tarado y este peso incluya lo anterior. Avisamos y ofrecemos
        // descontarlo, sin bloquear la venta.
        var sospecha =
          estado.config.venta.avisarSiNoTara &&
          !estado.pasoPorCero &&
          anterior > 0 &&
          gramos > anterior;

        var item = {
          uid: estado.uid++,
          producto_id: p.id,
          nombre: p.nombre,
          marca: p.marca,
          tipo: 'peso',
          cantidad: gramos,
          precio_centavos: p.precio_centavos,
        };
        var destino = modo === 'picada' ? estado.picada.items : estado.carrito;
        destino.push(item);
        estado.ultimoPesoCapturado = gramos;
        estado.pasoPorCero = false;
        pintarDe(destino);
        if (modo === estado.modo) mostrarConfirmacion(item);

        if (sospecha) {
          // Con una duda sobre el peso no corresponde volver sola a los grupos:
          // la pantalla espera a que se decida.
          cancelarReloj();
          avisar(
            'Parece que no se tareó: el peso incluye lo anterior.',
            'atencion',
            {
              texto: 'Restar ' + kg(anterior) + ' kg',
              fn: function () {
                item.cantidad = Math.max(1, gramos - anterior);
                estado.ultimoPesoCapturado = item.cantidad;
                pintarDe(destino);
                if (estado.vista === 'confirma') pintarConfirmacion(item);
              },
            }
          );
        }
      })
      .catch(function (e) { avisar('Error al leer la balanza: ' + e.message, 'error'); });
  }

  function esDePicada(uid) {
    return estado.picada.items.some(function (i) { return i.uid === uid; });
  }

  function quitarItem(uid) {
    var fuera = function (i) { return i.uid !== uid; };
    if (esDePicada(uid)) {
      estado.picada.items = estado.picada.items.filter(fuera);
      pintarPicada();
    } else {
      estado.carrito = estado.carrito.filter(fuera);
      pintarCarrito();
    }
    if (estado.vista === 'confirma') {
      if (!lista().length) volverAGrupos();
      else pintarConfirmacion(null);
    }
  }

  function cambiarCantidad(uid, delta) {
    var l = esDePicada(uid) ? estado.picada.items : estado.carrito;
    for (var i = 0; i < l.length; i++) {
      if (l[i].uid === uid) {
        l[i].cantidad += delta;
        if (l[i].cantidad <= 0) return quitarItem(uid);
        break;
      }
    }
    pintarDe(l);
    if (estado.vista === 'confirma') pintarConfirmacion(null);
  }

  /** Deslizar el item hacia cualquier costado lo elimina. */
  function habilitarSwipe(nodo, onBorrar) {
    var x0 = 0, dx = 0, activo = false;

    nodo.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.cant-ctrl')) return; // los +/- no arrastran
      activo = true;
      x0 = e.clientX;
      dx = 0;
      nodo.style.transition = 'none';
      try { nodo.setPointerCapture(e.pointerId); } catch (err) {}
    });

    nodo.addEventListener('pointermove', function (e) {
      if (!activo) return;
      dx = e.clientX - x0;
      nodo.style.transform = 'translateX(' + dx + 'px)';
      nodo.style.opacity = String(Math.max(0.25, 1 - Math.abs(dx) / 260));
    });

    function soltar() {
      if (!activo) return;
      activo = false;
      nodo.style.transition = 'transform .16s ease-out, opacity .16s ease-out';
      if (Math.abs(dx) > 110) {
        nodo.style.transform = 'translateX(' + (dx > 0 ? '110%' : '-110%') + ')';
        nodo.style.opacity = '0';
        setTimeout(onBorrar, 150);
      } else {
        nodo.style.transform = '';
        nodo.style.opacity = '';
      }
    }

    nodo.addEventListener('pointerup', soltar);
    nodo.addEventListener('pointercancel', soltar);
  }

  function pintarCarrito() {
    var carrito = estado.carrito;
    informarCarrito();
    el.carritoLista.innerHTML = '';

    if (!carrito.length) {
      el.carritoLista.innerHTML =
        '<div class="carrito-vacio"><div class="icono">🧺</div>' +
        '<div>Poné algo en la balanza<br>y elegí el producto</div></div>';
      el.total.textContent = plata(0);
      el.btnCobrar.disabled = true;
      estado.ultimoPesoCapturado = 0;
      estado.descuento = null;
      pintarDescuento();
      pintarMedios();
      pintarCabecera();
      programarQr();
      return;
    }

    var frag = document.createDocumentFragment();
    carrito.forEach(function (item) { frag.appendChild(nodoItem(item)); });
    el.carritoLista.appendChild(frag);

    pintarDescuento();
    el.total.textContent = plata(totalCarrito());
    pintarMedios();
    pintarCabecera();
    el.btnCobrar.disabled = estado.cerrando;
    programarQr();
  }

  /** Renglon del carrito o de la picada. detalle: reemplaza al de siempre. */
  function nodoItem(item, detalle) {
      var wrap = document.createElement('div');
      wrap.className = 'item-wrap';
      wrap.dataset.uid = item.uid;

      var fondo = document.createElement('div');
      fondo.className = 'fondo-borrar';
      fondo.innerHTML = '<span>Eliminar</span><span>Eliminar</span>';
      wrap.appendChild(fondo);

      var nodo = document.createElement('div');
      nodo.className = 'item';

      var info = document.createElement('div');
      info.className = 'item-info';

      var nom = document.createElement('div');
      nom.className = 'item-nombre';
      nom.textContent = item.nombre;
      info.appendChild(nom);

      // La marca va abajo y al final: si el renglon no entra, lo que se corta
      // es la marca y no la cantidad, que es el dato que hay que poder leer.
      var det = document.createElement('div');
      det.className = 'item-detalle num';
      det.textContent = (detalle || detalleDe(item)) + (item.marca ? ' · ' + item.marca : '');
      info.appendChild(det);

      nodo.appendChild(info);

      if (item.tipo === 'unidad') {
        var ctrl = document.createElement('div');
        ctrl.className = 'cant-ctrl';

        var menos = document.createElement('button');
        menos.className = 'cant-btn';
        menos.textContent = '−';
        menos.addEventListener('click', function () { cambiarCantidad(item.uid, -1); });

        var val = document.createElement('span');
        val.className = 'cant-valor num';
        val.textContent = item.cantidad;

        var mas = document.createElement('button');
        mas.className = 'cant-btn';
        mas.textContent = '+';
        mas.addEventListener('click', function () { cambiarCantidad(item.uid, 1); });

        ctrl.appendChild(menos);
        ctrl.appendChild(val);
        ctrl.appendChild(mas);
        nodo.appendChild(ctrl);
      }

      var sub = document.createElement('div');
      sub.className = 'item-subtotal num';
      sub.textContent = plata(subtotalDe(item));
      nodo.appendChild(sub);

      habilitarSwipe(nodo, function () { quitarItem(item.uid); });

      wrap.appendChild(nodo);
      return wrap;
  }

  // ------------------------------------------------------ simulacion de picada

  var CLAVE_MERMA = 'pos.picadaMermaKg';

  function leerMerma() {
    try { var v = parseInt(localStorage.getItem(CLAVE_MERMA), 10); return v > 0 ? v : 0; }
    catch (e) { return 0; }
  }

  function guardarMerma(v) {
    try { localStorage.setItem(CLAVE_MERMA, String(v)); } catch (e) {}
  }

  var CLAVE_PERSONA = 'pos.picadaGramosPersona';

  function leerGramosPersona() {
    try { var v = parseInt(localStorage.getItem(CLAVE_PERSONA), 10); return v > 0 ? v : 0; }
    catch (e) { return 0; }
  }

  /** Para cuantas personas alcanza: personas enteras (null si no se configuro). */
  function personasPicada() {
    var g = estado.picada.gPersona;
    return g > 0 ? Math.floor(gramosPicada() / g) : null;
  }

  function textoPersonas(n) {
    if (n === null) return '—';
    if (n === 0) return 'menos de 1 persona';
    return n === 1 ? '1 persona' : n + ' personas';
  }

  function enPicada() { return estado.modo === 'picada'; }

  /** La lista en la que se esta cargando: el carrito o la picada. */
  function lista() { return enPicada() ? estado.picada.items : estado.carrito; }

  function pintarDe(destino) {
    if (destino === estado.carrito) pintarCarrito(); else pintarPicada();
  }

  function gramosPicada() {
    return estado.picada.items.reduce(function (a, i) {
      return a + (i.tipo === 'peso' ? i.cantidad : 0);
    }, 0);
  }

  function fiambrePicada() {
    return estado.picada.items.reduce(function (a, i) { return a + subtotalDe(i); }, 0);
  }

  /** Merma: $ por kg × kg de la picada, en pesos enteros. */
  function mermaPicada() {
    return Math.round((estado.picada.mermaKg * gramosPicada()) / 100000) * 100;
  }

  function totalPicada() { return fiambrePicada() + mermaPicada(); }

  function totalActivo() { return enPicada() ? totalPicada() : totalCarrito(); }

  function porcentaje(parte, todo) {
    return todo ? Math.round((parte * 100) / todo) + '%' : '';
  }

  function pintarCabecera() {
    if (enPicada()) {
      var n = estado.picada.items.length;
      el.carritoTitulo.textContent = 'Simulación de picada';
      var pers = personasPicada();
      el.carritoContador.textContent = n
        ? n + (n === 1 ? ' artículo' : ' artículos') + ' · ' + kg(gramosPicada()) + ' kg' +
          (pers ? ' · ' + textoPersonas(pers) : '')
        : 'Sin artículos';
      if (el.totalMini) el.totalMini.textContent = plata(totalPicada());
    } else {
      var c = estado.carrito.length;
      el.carritoTitulo.textContent = '';
      el.carritoContador.textContent = c ? c + (c === 1 ? ' artículo' : ' artículos') : 'Sin artículos';
      if (el.totalMini) el.totalMini.textContent = plata(totalCarrito());
    }
  }

  function pintarPicada() {
    var items = estado.picada.items;
    var gramos = gramosPicada();
    var merma = mermaPicada();
    var fiambre = fiambrePicada();
    var total = fiambre + merma;
    var mKg = estado.picada.mermaKg;

    el.mermaDetalle.textContent = !mKg ? 'Lo que se pierde, por kg'
      : (gramos ? 'sobre ' + kg(gramos) + ' kg' : 'por kg de picada');
    el.mermaTotal.textContent = plata(merma);

    // Por persona: para cuantos alcanza y cuanto falta para uno mas.
    var gP = estado.picada.gPersona;
    var pers = personasPicada();
    el.personasTotal.textContent = pers === null ? '—' : textoPersonas(pers);
    el.picadaPersonas.textContent = textoPersonas(pers);
    el.personaDetalle.textContent = !gP ? 'Cuánto se calcula por persona'
      : 'faltan ' + ((pers + 1) * gP - gramos) + ' g para ' + (pers + 1);

    el.picadaItems.innerHTML = '';
    if (!items.length) {
      el.picadaItems.innerHTML =
        '<div class="picada-vacia"><div class="icono">🧀</div>' +
        '<div>Poné cada fiambre en la balanza<br>y elegí el producto</div></div>';
    } else {
      var frag = document.createDocumentFragment();
      items.forEach(function (i) {
        // Primero lo que importa en la picada: cuanto va y que parte es.
        frag.appendChild(nodoItem(i, i.tipo === 'peso'
          ? kg(i.cantidad) + ' kg · ' + porcentaje(i.cantidad, gramos) + ' · ' + plata(i.precio_centavos) + '/kg'
          : null));
      });
      el.picadaItems.appendChild(frag);
    }

    el.picadaFiambre.textContent = plata(fiambre);
    el.picadaMerma.textContent = plata(merma);
    el.picadaKg.textContent = kg(gramos) + ' kg';
    el.picadaPorKg.textContent = gramos ? plata(Math.round((total * 1000) / gramos / 100) * 100) + ' /kg' : '—';
    el.picadaTotal.textContent = plata(total);
    el.btnPicadaNueva.disabled = !items.length;
    if (enPicada()) pintarCabecera();
  }

  function cambiarModo(modo) {
    if (modo === estado.modo || estado.cerrando) return;
    estado.modo = modo;
    var p = modo === 'picada';
    document.body.classList.toggle('modo-picada', p);
    el.picadaBanner.hidden = !p;
    el.carritoLista.hidden = p;
    el.ventaPie.hidden = p;
    el.picadaPanel.hidden = !p;
    el.picadaPie.hidden = !p;
    el.accesoPicada.classList.toggle('activo', p);
    el.accesoPicadaTexto.textContent = p ? 'Venta' : 'Picada';
    el.accesoPicada.title = p ? 'Volver a la venta (también deslizando a la derecha)'
      : 'Simular una picada: cuánto de cada fiambre y cuánto sale (también deslizando a la izquierda)';
    volverAGrupos();
    cerrarHoja();
    pintarCabecera();
    if (p) pintarPicada();
    medirAsomo();
  }

  function nuevaPicada() {
    if (!estado.picada.items.length) return;
    avisar('¿Borrar la picada y empezar otra?', 'atencion', {
      texto: 'Borrar',
      fn: function () {
        estado.picada.items = [];
        pintarPicada();
        if (estado.vista === 'confirma') volverAGrupos();
      },
    });
  }

  function cambiarGramosPersona() {
    var n = Math.round(Number(String(el.gramosPersona.value).replace(',', '.')));
    estado.picada.gPersona = n > 0 ? n : 0;
    try { localStorage.setItem(CLAVE_PERSONA, String(estado.picada.gPersona)); } catch (e) {}
    pintarPicada();
    if (estado.vista === 'confirma') pintarConfirmacion(null);
  }

  function cambiarMerma() {
    var n = Number(String(el.mermaKg.value).replace(',', '.'));
    estado.picada.mermaKg = n > 0 ? Math.round(n * 100) : 0;
    guardarMerma(estado.picada.mermaKg);
    pintarPicada();
    if (estado.vista === 'confirma') pintarConfirmacion(null);
  }

  /**
   * Deslizar sobre la parte izquierda: de derecha a izquierda entra a la
   * picada, de izquierda a derecha vuelve a la venta. Solo cuenta un gesto
   * claramente horizontal; el vertical sigue siendo scroll de los grupos.
   */
  function habilitarGestoPicada() {
    var zona = document.querySelector('.izquierda');
    if (!zona) return;
    var activo = false, id = null, x0 = 0, y0 = 0, cortarClick = false;

    zona.addEventListener('pointerdown', function (e) {
      if (estado.ordenando || e.button > 0) return;
      if (e.target.closest('input, #columnas')) return;
      activo = true;
      id = e.pointerId;
      x0 = e.clientX;
      y0 = e.clientY;
    });

    zona.addEventListener('pointermove', function (e) {
      if (!activo || e.pointerId !== id) return;
      var dx = e.clientX - x0, dy = e.clientY - y0;
      if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx)) activo = false; // es scroll
    });

    zona.addEventListener('pointerup', function (e) {
      if (!activo || e.pointerId !== id) return;
      activo = false;
      var dx = e.clientX - x0, dy = e.clientY - y0;
      if (Math.abs(dx) < 90 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      // El dedo se levanto sobre un grupo o producto: ese toque no lo abre.
      cortarClick = true;
      setTimeout(function () { cortarClick = false; }, 350);
      cambiarModo(dx < 0 ? 'picada' : 'venta');
    });

    zona.addEventListener('pointercancel', function () { activo = false; });

    zona.addEventListener('click', function (e) {
      if (!cortarClick) return;
      cortarClick = false;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  /**
   * Mantener apretada la pantalla abre la camara para escanear (no hay boton).
   * Vale en cualquier parte del POS, sobre grupos y productos tambien. No
   * dispara con un toque corto, con un arrastre (scroll, deslizar la picada o
   * un item), con dos dedos, sobre campos de texto, dentro de un modal, con la
   * camara ya abierta ni en modo ordenar. Al disparar vibra y el click que
   * seguiria al soltar se anula, para no abrir el grupo que quedo debajo.
   */
  var MS_MANTENER = 600;

  function habilitarMantenerEscanear() {
    var timer = null, x0 = 0, y0 = 0, cortarClick = false;

    function cancelar() {
      if (timer) { clearTimeout(timer); timer = null; }
    }

    document.addEventListener('pointerdown', function (e) {
      cancelar();
      cortarClick = false;
      if (!e.isPrimary || e.button > 0) return;               // segundo dedo / otro boton
      if (!estado.camara || estado.ordenando || !window.Camara || window.Camara.abierta()) return;
      if (e.target.closest && e.target.closest('input, select, textarea, #columnas, .selector-estacion')) return;
      x0 = e.clientX;
      y0 = e.clientY;
      timer = setTimeout(function () {
        timer = null;
        cortarClick = true;
        if (navigator.vibrate) { try { navigator.vibrate(20); } catch (err) {} }
        abrirCamara();
      }, MS_MANTENER);
    }, true);

    document.addEventListener('pointermove', function (e) {
      if (timer && (Math.abs(e.clientX - x0) > 10 || Math.abs(e.clientY - y0) > 10)) cancelar();
    }, true);
    document.addEventListener('pointerup', cancelar, true);
    document.addEventListener('pointercancel', cancelar, true);

    document.addEventListener('click', function (e) {
      if (!cortarClick) return;
      cortarClick = false;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    // El mantener apretado largo suele abrir el menu contextual del navegador.
    document.addEventListener('contextmenu', function (e) {
      if (e.target.closest && e.target.closest('input, textarea')) return;
      if (timer || cortarClick) e.preventDefault();
    }, true);
  }

  // ------------------------------------------------------------- descuentos

  function pintarDescuento() {
    var d = estado.descuento;
    el.btnDescuento.classList.toggle('aplicado', !!d);
    el.btnDescuentoTexto.textContent = d ? d.nombre + ' · ' + textoDescuento(d) : 'Descuento';
    el.descuentoMonto.hidden = !d;
    if (d) el.descuentoMonto.textContent = '− ' + plata(descuentoDe(d, totalBruto()));
  }

  function aplicarDescuento(d) {
    estado.descuento = d;
    pintarCarrito();
    if (estado.vista === 'confirma') pintarConfirmacion();
  }

  function cargarDescuentos() {
    return fetch('/api/descuentos')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error);
        estado.descuentos = d.descuentos || [];
        // Si el aplicado se elimino (en otro equipo), se saca de la venta.
        if (estado.descuento && !estado.descuentos.some(function (x) { return x.id === estado.descuento.id; })) {
          aplicarDescuento(null);
        }
      });
  }

  function pintarListaDescuentos() {
    var lista = el.descuentosLista;
    lista.innerHTML = '';
    if (!estado.descuentos.length) {
      lista.innerHTML = '<div class="desc-vacio">Todavía no hay descuentos. Agregá uno abajo.</div>';
    }
    var bruto = totalBruto();
    estado.descuentos.forEach(function (d) {
      var b = document.createElement('div');
      b.className = 'selector-opcion desc-opcion' +
        (estado.descuento && estado.descuento.id === d.id ? ' actual' : '');
      b.setAttribute('role', 'button');
      b.tabIndex = 0;

      var txt = document.createElement('div');
      txt.className = 'desc-opcion-texto';
      var nom = document.createElement('span');
      nom.className = 'selector-nombre';
      nom.textContent = d.nombre + ' · ' + textoDescuento(d);
      txt.appendChild(nom);
      if (bruto) {
        var det = document.createElement('span');
        det.className = 'selector-equipos num';
        det.textContent = '− ' + plata(descuentoDe(d, bruto)) + ' sobre ' + plata(bruto);
        txt.appendChild(det);
      }
      b.appendChild(txt);

      var x = document.createElement('button');
      x.type = 'button';
      x.className = 'desc-borrar';
      x.title = 'Eliminar este descuento';
      x.textContent = '×';
      x.addEventListener('click', function (e) {
        e.stopPropagation();
        avisar('¿Eliminar el descuento “' + d.nombre + '”?', 'atencion', {
          texto: 'Eliminar',
          fn: function () { borrarDescuento(d); },
        });
      });
      b.appendChild(x);

      b.addEventListener('click', function () {
        aplicarDescuento(d);
        cerrarDescuentos();
      });
      lista.appendChild(b);
    });
    el.btnSinDescuento.hidden = !estado.descuento;
  }

  function abrirDescuentos() {
    if (estado.reloj || estado.relojHoja) cancelarReloj();
    pintarListaDescuentos();
    el.modalDescuentos.hidden = false;
    cargarDescuentos().then(pintarListaDescuentos)
      .catch(function (e) { avisar('No se pudieron leer los descuentos: ' + e.message, 'error'); });
  }

  function cerrarDescuentos() { el.modalDescuentos.hidden = true; }

  function elegirTipo(tipo) {
    estado.descTipo = tipo === 'monto' ? 'monto' : 'porcentaje';
    el.descTipo.querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('activo', b.dataset.tipo === estado.descTipo);
    });
    el.descValor.placeholder = estado.descTipo === 'monto' ? 'Monto $' : 'Porcentaje';
  }

  function crearDescuento(ev) {
    ev.preventDefault();
    var nombre = el.descNombre.value.trim();
    var num = Number(String(el.descValor.value).replace(',', '.'));
    if (!nombre) { avisar('Poné un nombre para el descuento', 'error'); el.descNombre.focus(); return; }
    if (!(num > 0)) { avisar('Poné un valor mayor a cero', 'error'); el.descValor.focus(); return; }
    var valor = estado.descTipo === 'monto' ? Math.round(num * 100) : Math.round(num);

    fetch('/api/descuentos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: nombre, tipo: estado.descTipo, valor: valor }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error);
        estado.descuentos.push(d.descuento);
        el.descNombre.value = '';
        el.descValor.value = '';
        pintarListaDescuentos();
      })
      .catch(function (e) { avisar('No se pudo agregar: ' + e.message, 'error'); });
  }

  function borrarDescuento(d) {
    fetch('/api/descuentos/' + d.id, { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r.ok && !/no existe/i.test(r.error || '')) throw new Error(r.error);
        estado.descuentos = estado.descuentos.filter(function (x) { return x.id !== d.id; });
        if (estado.descuento && estado.descuento.id === d.id) aplicarDescuento(null);
        if (!el.modalDescuentos.hidden) pintarListaDescuentos();
      })
      .catch(function (e) { avisar('No se pudo eliminar: ' + e.message, 'error'); });
  }

  // ------------------------------------------- carrito a pantalla completa

  /**
   * Despues de cargar un articulo (balanza o escaner) la pantalla muestra el
   * carrito unos segundos y vuelve sola a los grupos. Tocar la pantalla corta
   * la cuenta regresiva: queda esperando a que se toque "Volver a los grupos".
   */
  function mostrarConfirmacion(item) {
    if (esHoja()) return asomarHoja(item);
    pintarConfirmacion(item);
    mostrarVista('confirma');
    arrancarReloj();
  }

  function pintarConfirmacion(item) {
    if (item) estado.itemConfirmado = item;

    // Si el articulo se borro del carrito mientras estaba en pantalla, deja de
    // encabezar la vista.
    var items = lista();
    var actual = estado.itemConfirmado;
    if (actual && items.indexOf(actual) === -1) actual = estado.itemConfirmado = null;

    el.confirmaNuevo.hidden = !actual;
    if (actual) {
      el.confirmaNombre.textContent = actual.nombre + (actual.marca ? ' · ' + actual.marca : '');
      el.confirmaDetalle.textContent = detalleDe(actual);
      el.confirmaSubtotal.textContent = plata(subtotalDe(actual));
    }

    el.confirmaLista.innerHTML = '';
    var frag = document.createDocumentFragment();

    // El articulo recien cargado ya se muestra arriba en grande: abajo va el
    // resto de la venta, para no repetir el mismo renglon dos veces.
    var resto = items.filter(function (i) { return !actual || i.uid !== actual.uid; });
    if (resto.length) {
      var titulo = document.createElement('div');
      titulo.className = 'confirma-titulo';
      titulo.textContent = enPicada() ? 'Resto de la picada' : 'Resto de la venta';
      frag.appendChild(titulo);
    }

    resto.forEach(function (i) {
      var fila = document.createElement('div');
      fila.className = 'confirma-fila';

      var nom = document.createElement('div');
      nom.className = 'confirma-fila-nombre';
      nom.textContent = i.nombre;

      var det = document.createElement('div');
      det.className = 'confirma-fila-detalle num';
      det.textContent = detalleDe(i);

      var sub = document.createElement('div');
      sub.className = 'confirma-fila-subtotal num';
      sub.textContent = plata(subtotalDe(i));

      fila.appendChild(nom);
      fila.appendChild(det);
      fila.appendChild(sub);
      frag.appendChild(fila);
    });

    // En la picada, la merma va al final (se cobra por el peso total).
    if (enPicada() && estado.picada.mermaKg) {
      var fm = document.createElement('div');
      fm.className = 'confirma-fila';
      fm.innerHTML = '<div class="confirma-fila-nombre">Merma</div>' +
        '<div class="confirma-fila-detalle num"></div><div class="confirma-fila-subtotal num"></div>';
      fm.children[1].textContent = kg(gramosPicada()) + ' kg × ' + plata(estado.picada.mermaKg) + '/kg';
      fm.children[2].textContent = plata(mermaPicada());
      frag.appendChild(fm);
    }
    if (enPicada() && personasPicada() !== null) {
      var fp = document.createElement('div');
      fp.className = 'confirma-fila';
      fp.innerHTML = '<div class="confirma-fila-nombre">Alcanza para</div>' +
        '<div class="confirma-fila-detalle num"></div><div class="confirma-fila-subtotal num"></div>';
      fp.children[1].textContent = estado.picada.gPersona + ' g por persona';
      fp.children[2].textContent = textoPersonas(personasPicada());
      frag.appendChild(fp);
    }
    el.confirmaLista.appendChild(frag);

    el.confirmaTotalRotulo.textContent = enPicada() ? 'Total de la picada' : 'Total de la venta';
    el.confirmaTotal.textContent = plata(totalActivo());
  }

  function segundosDeEspera() {
    var s = Number(estado.config.venta.segundosCarrito);
    return isFinite(s) && s > 0 ? s : 3;
  }

  function arrancarReloj() {
    cancelarReloj();
    var segundos = segundosDeEspera();
    var restan = segundos;

    el.btnSeguir.textContent = 'Seguir (' + restan + ')';
    el.barraTiempo.style.transition = 'none';
    el.barraTiempo.style.width = '100%';
    // Reflow forzado: sin esto la transicion arrancaria desde el ancho viejo.
    void el.barraTiempo.offsetWidth;
    el.barraTiempo.style.transition = 'width ' + segundos + 's linear';
    el.barraTiempo.style.width = '0%';

    estado.tic = setInterval(function () {
      restan -= 1;
      if (restan >= 0) el.btnSeguir.textContent = 'Seguir (' + restan + ')';
    }, 1000);

    estado.reloj = setTimeout(volverAGrupos, segundos * 1000);
  }

  function cancelarReloj() {
    cancelarRelojHoja();
    if (estado.reloj) { clearTimeout(estado.reloj); estado.reloj = null; }
    if (estado.tic) { clearInterval(estado.tic); estado.tic = null; }
    el.btnSeguir.textContent = 'Volver a los grupos';
    // La barra se congela donde este.
    var ancho = getComputedStyle(el.barraTiempo).width;
    el.barraTiempo.style.transition = 'none';
    el.barraTiempo.style.width = ancho;
  }

  // ------------------------------------------------ carrito como hoja (celular)

  /*
   * En pantallas angostas el carrito no ocupa la parte de abajo: es una hoja
   * que asoma (manija + total) y se sube o se baja arrastrando con el dedo.
   * Al cargar un articulo sube sola, muestra el carrito unos segundos y vuelve
   * a bajar. Si alguien la toca mientras esta arriba, se queda arriba.
   */
  var mqHoja = window.matchMedia ? window.matchMedia('(max-width: 900px)') : null;
  function esHoja() { return !!(mqHoja && mqHoja.matches && el.hoja); }

  /** Cuanto asoma la hoja cerrada: la manija y la cabecera, medidas de verdad. */
  function medirAsomo() {
    if (!el.hoja) return;
    if (!esHoja()) {
      document.documentElement.style.removeProperty('--hoja-asomo');
      return;
    }
    var alto = el.hojaAsa.offsetHeight + el.carritoCab.offsetHeight;
    document.documentElement.style.setProperty('--hoja-asomo', alto + 'px');
  }

  function abrirHoja() {
    if (!esHoja()) return;
    estado.hojaAbierta = true;
    el.hoja.classList.add('abierta');
    el.hojaFondo.classList.add('visible');
  }

  function cerrarHoja() {
    cancelarRelojHoja();
    estado.hojaAbierta = false;
    if (!el.hoja) return;
    el.hoja.classList.remove('abierta');
    el.hojaFondo.classList.remove('visible');
    el.carritoLista.scrollTop = 0;
  }

  function asomarHoja(item) {
    // Detras de la hoja, la pantalla ya vuelve a los grupos.
    if (estado.vista !== 'grupos' || estado.filtro) volverAGrupos();
    abrirHoja();

    var nodo = item && (enPicada() ? el.picadaItems : el.carritoLista).querySelector('.item-wrap[data-uid="' + item.uid + '"]');
    if (nodo) {
      nodo.classList.add('nuevo');
      if (nodo.scrollIntoView) nodo.scrollIntoView({ block: 'nearest' });
    }

    cancelarRelojHoja();
    var segundos = segundosDeEspera();
    el.hojaTiempo.style.transition = 'none';
    el.hojaTiempo.style.width = '100%';
    void el.hojaTiempo.offsetWidth;
    el.hojaTiempo.style.transition = 'width ' + segundos + 's linear';
    el.hojaTiempo.style.width = '0%';
    estado.relojHoja = setTimeout(function () {
      estado.relojHoja = null;
      cerrarHoja();
    }, segundos * 1000);
  }

  function cancelarRelojHoja() {
    if (estado.relojHoja) { clearTimeout(estado.relojHoja); estado.relojHoja = null; }
    if (el.hojaTiempo) {
      el.hojaTiempo.style.transition = 'none';
      el.hojaTiempo.style.width = '0';
    }
  }

  /** Arrastre desde la manija o la cabecera. Un toque sin arrastrar alterna. */
  function habilitarHoja() {
    if (!el.hoja) return;

    var activo = false, movio = false, y0 = 0, base = 0, cerrada = 0, pos = 0;
    var tUlt = 0, yUlt = 0, vel = 0;

    function inicio(e) {
      if (!esHoja()) return;
      if (e.target.closest('a, button')) return; // "Administrar" sigue siendo un link
      activo = true;
      movio = false;
      y0 = yUlt = e.clientY;
      tUlt = e.timeStamp;
      vel = 0;
      cerrada = el.hoja.offsetHeight - el.hojaAsa.offsetHeight - el.carritoCab.offsetHeight;
      base = estado.hojaAbierta ? 0 : cerrada;
      pos = base;
      cancelarRelojHoja();
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) {}
    }

    function mover(e) {
      if (!activo) return;
      var dy = e.clientY - y0;
      if (!movio && Math.abs(dy) < 6) return;
      if (!movio) {
        movio = true;
        el.hoja.classList.add('arrastrando');
        el.hojaFondo.classList.add('arrastrando', 'visible');
      }
      pos = Math.min(cerrada, Math.max(0, base + dy));
      el.hoja.style.transform = 'translateY(' + pos + 'px)';
      el.hojaFondo.style.opacity = String(1 - pos / (cerrada || 1));

      var dt = e.timeStamp - tUlt;
      if (dt > 0) vel = (e.clientY - yUlt) / dt; // px por ms, + = hacia abajo
      tUlt = e.timeStamp;
      yUlt = e.clientY;
    }

    function fin() {
      if (!activo) return;
      activo = false;
      el.hoja.classList.remove('arrastrando');
      el.hojaFondo.classList.remove('arrastrando');
      el.hoja.style.transform = '';
      el.hojaFondo.style.opacity = '';

      var abrir;
      if (!movio) abrir = !estado.hojaAbierta;           // toque: alterna
      else if (vel > 0.4) abrir = false;                   // tiron hacia abajo
      else if (vel < -0.4) abrir = true;                   // tiron hacia arriba
      else abrir = pos < cerrada / 2;                      // donde quedo

      if (abrir) abrirHoja(); else cerrarHoja();
    }

    [el.hojaAsa, el.carritoCab].forEach(function (zona) {
      zona.addEventListener('pointerdown', inicio);
      zona.addEventListener('pointermove', mover);
      zona.addEventListener('pointerup', fin);
      zona.addEventListener('pointercancel', fin);
    });

    // Tocar afuera la baja.
    el.hojaFondo.addEventListener('click', cerrarHoja);

    medirAsomo();
    window.addEventListener('load', medirAsomo);
    window.addEventListener('resize', function () {
      medirAsomo();
      if (!esHoja()) cerrarHoja();
    });
  }

  // ---------------------------------------------------------------- cierre

  /** Venta ya guardada (efectivo/otros o QR): aviso, carrito limpio y a la pantalla de grupos. */
  function ventaCobrada(venta, medio) {
    avisar('Venta #' + venta.id + ' guardada' + medio + ' · ' + plata(venta.total_centavos) +
      (venta.descuento_centavos ? ' (desc. ' + plata(venta.descuento_centavos) + ')' : ''), 'ok');
    estado.carrito = [];
    estado.descuento = null;
    estado.ultimoPesoCapturado = 0;
    estado.pasoPorCero = true;
    pintarCarrito();
    volverAGrupos();
    cerrarHoja();
  }

  /** Cierre en efectivo/otros. Si hay una orden de QR viva, se baja antes (puede haberse pagado justo). */
  function cerrarVenta(medio) {
    if (!estado.carrito.length || estado.cerrando) return;
    if (estado.qr || estado.qrOcupado) {
      estado.cerrando = true;
      el.btnCobrar.disabled = true;
      el.btnTarjeta.disabled = true;
      if (estado.qrOcupado) avisar('Se está preparando el QR: probá de nuevo en un segundo', 'atencion');
      bajarQr().then(function (seguir) {
        estado.cerrando = false;
        if (seguir) cerrarVentaDirecta(medio);
        else { el.btnCobrar.disabled = estado.carrito.length === 0; pintarMedios(); }
      });
      return;
    }
    cerrarVentaDirecta(medio);
  }

  function cerrarVentaDirecta(medio) {
    if (!estado.carrito.length || estado.cerrando) return;

    var conTarjeta = medio === 'tarjeta';
    estado.cerrando = true;
    el.btnCobrar.disabled = true;
    el.btnTarjeta.disabled = true;
    (conTarjeta ? el.btnTarjetaTexto : el.btnCobrarTexto).textContent = 'Guardando…';

    var items = estado.carrito.map(function (i) {
      return {
        producto_id: i.producto_id,
        nombre: i.nombre,
        marca: i.marca,
        tipo: i.tipo,
        cantidad: i.cantidad,
        precio_centavos: i.precio_centavos,
      };
    });

    fetch('/api/ventas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: items,
        estacion: estado.estacion,
        descuento_id: estado.descuento ? estado.descuento.id : null,
        medio_pago: conTarjeta ? 'tarjeta' : '',
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error);
        ventaCobrada(d.venta, conTarjeta ? ' · Tarjeta' : '');
      })
      .catch(function (e) {
        avisar('No se pudo guardar la venta: ' + e.message, 'error');
      })
      .finally(function () {
        estado.cerrando = false;
        el.btnCobrarTexto.textContent = 'Cerrar venta';
        el.btnCobrar.disabled = estado.carrito.length === 0;
        pintarMedios();
      });
  }

  // ------------------------------------------------------------- cobro por QR
  //
  // Automatico: con el carrito armado, la orden en la caja de Mercado Pago se crea sola
  // (cuando el carrito deja de cambiar) y se mantiene al dia. El cliente escanea el QR fijo,
  // ve el monto y la venta se guarda sola al acreditarse. Sin boton.

  var CLAVE_QR = 'pos.cobroQr';
  var QR_ESPERA_MS = 1200;      // el carrito tiene que quedar quieto antes de pedir la orden
  var QR_REINTENTO_MS = 15000;  // si MP falla o la caja esta ocupada

  function guardarCobroQr(id) {
    try { if (id) localStorage.setItem(CLAVE_QR, id); else localStorage.removeItem(CLAVE_QR); } catch (e) { /* sin storage */ }
  }

  function estadoQr(texto, clase) {
    el.qrEstado.textContent = texto;
    el.qrEstado.className = 'qr-estado ' + (clase || '');
    pintarQrBoton();
    el.qrBanda.hidden = false;
  }

  /** Boton QR junto a "Cerrar venta": rojo (activo) cancela el QR de esta venta, azul lo activa. */
  function pintarQrBoton() {
    var activo = !estado.qrApagado && !!estado.carrito.length;
    el.qrBoton.hidden = !estado.qrDisponible;
    el.qrBoton.disabled = !estado.carrito.length;
    el.qrBoton.classList.toggle('activo', activo);
    el.qrBoton.setAttribute('aria-label', estado.qrApagado ? 'Generar QR' : 'Cancelar QR');
  }

  /** QR cancelado a mano: no se genera ninguno hasta apretar "Generar QR" o empezar otra venta. */
  function pintarQrApagado() {
    el.qrMonto.textContent = '';
    estadoQr('QR cancelado en esta venta', '');
  }

  function mostrarQr(q) {
    el.qrMonto.textContent = plata(q.total);
    estadoQr('Esperando el pago', 'espera');
  }

  function liberarQr() {
    if (estado.qr && estado.qr.timer) clearTimeout(estado.qr.timer);
    estado.qr = null;
    guardarCobroQr(null);
    el.qrBanda.hidden = true;
    pintarQrBoton();
  }

  /** Identifica el contenido del carrito: si no cambia, la orden viva sigue valiendo. */
  function firmaCarrito() {
    if (!estado.carrito.length) return '';
    return JSON.stringify([
      estado.carrito.map(function (i) { return [i.producto_id, i.nombre, i.marca, i.tipo, i.cantidad, i.precio_centavos]; }),
      estado.descuento ? estado.descuento.id : null,
    ]);
  }

  /** Se llama cada vez que se pinta el carrito: agenda la sincronizacion si algo cambio. */
  function programarQr(ms) {
    if (!estado.qrDisponible) return;
    var firma = firmaCarrito();
    if (!firma) {
      estado.qrPausaFirma = null;
      if (estado.qrApagado) { // venta terminada: vuelve el modo automatico
        estado.qrApagado = false;
        if (!estado.qr) el.qrBanda.hidden = true;
      }
    }
    pintarQrBoton();
    if (estado.qrApagado) {
      if (estado.qr) { if (estado.qrSync) clearTimeout(estado.qrSync); estado.qrSync = setTimeout(sincronizarQr, 0); }
      else pintarQrApagado();
      return;
    }
    if (firma && firma === estado.qrPausaFirma) return;
    if (ms === undefined && ((estado.qr && estado.qr.firma) || '') === firma) return; // nada que hacer
    if (estado.qrSync) clearTimeout(estado.qrSync);
    estado.qrSync = setTimeout(sincronizarQr, ms === undefined ? QR_ESPERA_MS : ms);
  }

  function sincronizarQr() {
    estado.qrSync = null;
    if (!estado.qrDisponible) return;
    if (estado.qrOcupado) { estado.qrRepetir = true; return; }
    var firma = firmaCarrito();
    var q = estado.qr;
    if (estado.qrApagado) { // cancelado a mano: se baja la orden viva y no se genera otra
      if (!q) { pintarQrApagado(); return; }
      bajarQr().then(function () {
        if (estado.qr) { estado.qrApagado = false; pintarQrBoton(); } // no se pudo bajar: sigue viva
        else if (estado.qrApagado) pintarQrApagado();
      });
      return;
    }
    if (firma && firma === estado.qrPausaFirma) return;
    if (q && q.firma === firma) return;
    if (!firma) { // carrito vacio: se baja la orden
      if (q && q.firma) bajarQr();
      else if (!q) el.qrBanda.hidden = true;
      return;
    }
    crearQr(q);
  }

  function crearQr(previa) {
    var firma = firmaCarrito();
    var items = estado.carrito.map(function (i) {
      return { producto_id: i.producto_id, nombre: i.nombre, marca: i.marca, tipo: i.tipo, cantidad: i.cantidad, precio_centavos: i.precio_centavos };
    });
    estado.qrOcupado = true;
    if (previa && previa.timer) { clearTimeout(previa.timer); previa.timer = null; }
    estadoQr('Preparando el QR', 'espera');

    fetch('/api/cobros-qr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: items,
        estacion: estado.estacion,
        descuento_id: estado.descuento ? estado.descuento.id : null,
        reemplaza: previa ? previa.id : null,
      }),
    })
      .then(function (r) { return r.json().then(function (d) { d.http = r.status; return d; }); })
      .then(function (d) {
        if (!d.ok) { var err = new Error(d.error); err.http = d.http; throw err; }
        if (d.cobro.estado === 'pagado') { resolverQr(d, previa); return; } // la anterior se pagó justo antes
        var q = { id: d.cobro.id, total: d.cobro.total_centavos, firma: firma, timer: null };
        estado.qr = q;
        guardarCobroQr(q.id);
        mostrarQr(q);
        q.timer = setTimeout(consultarQr, estado.qrConsultaMs);
      })
      .catch(function (e) {
        if (previa && estado.qr === previa) previa.timer = setTimeout(consultarQr, estado.qrConsultaMs);
        else if (!previa) el.qrMonto.textContent = '';
        estadoQr('QR no disponible: ' + e.message, 'fallo');
        // 400 = el carrito no se puede cobrar así (total cero, etc.): espera a que cambie.
        if (e.http !== 400) programarQr(e.http === 409 ? 4000 : QR_REINTENTO_MS);
      })
      .then(function () {
        estado.qrOcupado = false;
        if (estado.qrRepetir) { estado.qrRepetir = false; programarQr(0); }
      });
  }

  /** Pregunta al servidor (que pregunta a Mercado Pago) cada pocos segundos. */
  function consultarQr() {
    var q = estado.qr;
    if (!q) return;
    fetch('/api/cobros-qr/' + encodeURIComponent(q.id))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (estado.qr !== q) return; // se reemplazó o bajó mientras esperábamos
        if (!d.ok) throw new Error(d.error);
        resolverQr(d, q);
      })
      .catch(function () {
        if (estado.qr !== q) return;
        estadoQr('Sin conexión con el POS, reintentando…', ''); // la orden sigue viva en el servidor
        q.timer = setTimeout(consultarQr, estado.qrConsultaMs);
      });
  }

  function resolverQr(d, q) {
    var estadoCobro = d.cobro.estado;
    if (estadoCobro === 'pagado') {
      var venta = d.venta || { id: d.cobro.venta_id, total_centavos: d.cobro.total_centavos };
      var firmaActual = firmaCarrito();
      var igual = !!(q && q.firma) && q.firma === firmaActual;
      liberarQr();
      if (igual) {
        ventaCobrada(venta, ' · QR');
      } else if (q && q.firma && firmaActual) {
        // Pagaron una versión anterior del carrito: no se vuelve a cobrar por QR hasta que cambie.
        estado.qrPausaFirma = firmaActual;
        avisar('Venta #' + venta.id + ' cobrada por QR · ' + plata(venta.total_centavos) + '. El carrito cambió después del pago: revisá qué falta cobrar', 'atencion');
      } else {
        avisar('Venta #' + venta.id + ' cobrada por QR · ' + plata(venta.total_centavos), 'ok');
      }
      return;
    }
    if (estadoCobro === 'pendiente') {
      estadoQr(d.aviso || 'Esperando el pago', d.aviso ? 'fallo' : 'espera');
      q.timer = setTimeout(consultarQr, estado.qrConsultaMs);
      return;
    }
    // Vencida o cancelada desde afuera: si el carrito sigue, se renueva sola.
    liberarQr();
    if (estadoCobro === 'reembolsado') avisar('El pago por QR fue reembolsado', 'atencion');
    programarQr(0);
  }

  /**
   * Baja la orden viva (carrito vacío o cierre en efectivo). Devuelve una promesa:
   * true = se puede seguir; false = se pagó justo (ya quedó guardada) o no se pudo bajar.
   */
  function bajarQr() {
    var q = estado.qr;
    if (estado.qrOcupado) { estado.qrRepetir = true; return Promise.resolve(false); }
    if (!q) return Promise.resolve(true);
    if (q.timer) { clearTimeout(q.timer); q.timer = null; }
    return fetch('/api/cobros-qr/' + encodeURIComponent(q.id) + '/cancelar', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error);
        if (d.cobro.estado === 'pagado') { resolverQr(d, q); return false; } // justo se pagó
        liberarQr();
        return true;
      })
      .catch(function (e) {
        estadoQr('No se pudo bajar el QR: ' + e.message, 'fallo');
        if (estado.qr === q) q.timer = setTimeout(consultarQr, estado.qrConsultaMs);
        return false;
      });
  }

  /** Recarga de la pantalla: si había una orden viva se sigue mirando (vence sola o se paga). */
  function retomarQr() {
    var id = null;
    try { id = localStorage.getItem(CLAVE_QR); } catch (e) { /* sin storage */ }
    if (!id) return;
    fetch('/api/cobros-qr/' + encodeURIComponent(id))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { guardarCobroQr(null); return; }
        if (d.cobro.estado === 'pendiente') {
          if (estado.qr) return;
          estado.qr = { id: id, total: d.cobro.total_centavos, firma: null, timer: null };
          mostrarQr(estado.qr);
          estado.qr.timer = setTimeout(consultarQr, estado.qrConsultaMs);
          programarQr(0);
        } else if (d.cobro.estado === 'pagado') {
          guardarCobroQr(null);
          avisar('Venta #' + d.cobro.venta_id + ' cobrada por QR · ' + plata(d.cobro.total_centavos), 'ok');
        } else {
          guardarCobroQr(null);
        }
      })
      .catch(function () {});
  }

  /** Boton QR: rojo = "Cancelar QR" baja la orden de esta venta; "Generar QR" vuelve al modo automatico. */
  el.qrBoton.addEventListener('click', function () {
    if (!estado.qrDisponible) return;
    if (estado.qrApagado) {
      estado.qrApagado = false;
      estado.qrPausaFirma = null;
      estadoQr('Preparando el QR', 'espera');
      programarQr(0);
    } else {
      estado.qrApagado = true;
      if (estado.qrSync) { clearTimeout(estado.qrSync); estado.qrSync = null; }
      sincronizarQr();
    }
    pintarQrBoton();
  });

  function iniciarQr() {
    fetch('/api/cobros-qr/estado')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok || !d.habilitado) return;
        estado.qrDisponible = true;
        estado.qrConsultaMs = Math.max(2, Number(d.consulta_segundos) || 3) * 1000;
        pintarQrBoton();
        retomarQr();
        programarQr(0);
      })
      .catch(function () {});
  }

  // ---------------------------------------------------------------- escaner

  function porCodigo(codigo) {
    fetch('/api/productos/codigo/' + encodeURIComponent(codigo))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          avisar('Código ' + codigo + ' sin producto asociado', 'error');
          return;
        }
        // Escanear tambien lleva al carrito y vuelve solo a los grupos.
        agregarProducto(d.producto);
      })
      .catch(function () { avisar('Error al buscar el código', 'error'); })
      .finally(function () {
        // El escaner puede haber escrito en el buscador: lo limpiamos.
        if (el.buscador.value) {
          el.buscador.value = '';
          estado.filtro = '';
        }
      });
  }

  // ---------------------------------------------------------------- arranque

  function init() {
    // Red de seguridad por si el navegador se quedo con un index.html viejo en
    // cache: mejor un mensaje claro que un error de JavaScript a mitad de camino.
    if (!el.grupos || !el.vistaConfirma || !el.btnSeguir || !el.selectorEstacion || !el.modalDescuentos ||
        !el.picadaPanel || !el.accesoPicada || !el.vistaMarcas || !el.marcas) {
      avisar('La pantalla quedó vieja en la memoria del navegador.', 'error', {
        texto: 'Recargar',
        // Con un recargado normal el navegador puede volver a servir lo mismo de
        // la cache: cambiamos la direccion para forzar una copia nueva.
        fn: function () { location.replace(location.pathname + '?v=' + Date.now()); },
      });
      return;
    }

    el.buscador.addEventListener('input', function () {
      estado.filtro = el.buscador.value;
      if (estado.filtro.trim()) {
        // Sin coincidencias: error y se limpia.
        if (!productosVisibles().length) {
          avisar('Sin coincidencias para “' + estado.filtro.trim() + '”', 'error');
          volverAGrupos();
          return;
        }
        modoOrdenar(false);
        mostrarVista('productos');
        pintarGrilla();
      } else {
        volverAGrupos();
      }
    });

    el.btnVolver.addEventListener('click', volverDeProductos);
    el.btnVolverMarcas.addEventListener('click', volverAGrupos);
    el.btnSeguir.addEventListener('click', volverAGrupos);
    el.btnOrdenar.addEventListener('click', function () {
      if (estado.ordenando) { modoOrdenar(false); return; }
      // Se acomoda la pantalla donde se esta: grupos, marcas del grupo o productos.
      // Desde cualquier otra (confirmacion, buscador): primero a los grupos.
      var enGrupo = estado.grupoId !== null && !estado.filtro.trim() &&
        (estado.vista === 'marcas' || estado.vista === 'productos');
      if (!enGrupo && (estado.vista !== 'grupos' || estado.filtro)) volverAGrupos();
      modoOrdenar(true);
    });
    if (el.columnas) {
      el.columnas.addEventListener('click', function (e) {
        var b = e.target.closest('button[data-col]');
        if (b) elegirColumnas(b.dataset.col);
      });
    }
    aplicarColumnas(leerColumnas());

    // Tocar el carrito (el de la pantalla o el de la derecha) corta la vuelta
    // automatica: el que atiende manda, la pantalla espera.
    function frenarVuelta(e) {
      if (e.target.closest('#btnSeguir')) return;
      if (estado.reloj || estado.relojHoja) cancelarReloj();
    }
    el.vistaConfirma.addEventListener('pointerdown', frenarVuelta);
    var panelCarrito = document.querySelector('.derecha');
    if (panelCarrito) panelCarrito.addEventListener('pointerdown', frenarVuelta);

    el.btnCobrar.addEventListener('click', function () { cerrarVenta(''); });
    el.btnTarjeta.addEventListener('click', abrirTarjeta);
    el.tarjetaVolver.addEventListener('click', cerrarTarjeta);
    el.tarjetaCobrado.addEventListener('click', function () { cerrarTarjeta(); cerrarVenta('tarjeta'); });

    el.btnDescuento.addEventListener('click', abrirDescuentos);
    el.descuentosCerrar.addEventListener('click', cerrarDescuentos);
    el.btnSinDescuento.addEventListener('click', function () { aplicarDescuento(null); cerrarDescuentos(); });
    el.modalDescuentos.addEventListener('click', function (e) {
      if (e.target === el.modalDescuentos) cerrarDescuentos();
    });
    el.descTipo.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-tipo]');
      if (b) elegirTipo(b.dataset.tipo);
    });
    el.descForm.addEventListener('submit', crearDescuento);
    elegirTipo('porcentaje');

    // Accesos a Ventas y Administrar. El carrito vive solo en esta pantalla:
    // con una venta a medio cargar no se sale sin avisar.
    document.querySelectorAll('a.acceso').forEach(function (a) {
      a.addEventListener('click', function (e) {
        var n = estado.carrito.length;
        if (!n && !estado.cerrando) return;
        e.preventDefault();
        if (estado.cerrando) return;
        avisar('Hay una venta abierta (' + n + (n === 1 ? ' artículo' : ' artículos') +
          '). Cerrala antes de salir; si salís ahora se pierde.', 'atencion', {
          texto: 'Salir igual',
          fn: function () { location.href = a.href; },
        });
      });
    });

    habilitarArrastre();
    habilitarHoja();
    habilitarGestoPicada();
    habilitarMantenerEscanear();

    // Simulacion de picada
    estado.picada.mermaKg = leerMerma();
    el.mermaKg.value = estado.picada.mermaKg ? String(estado.picada.mermaKg / 100) : '';
    el.mermaKg.addEventListener('input', cambiarMerma);
    estado.picada.gPersona = leerGramosPersona();
    el.gramosPersona.value = estado.picada.gPersona ? String(estado.picada.gPersona) : '';
    el.gramosPersona.addEventListener('input', cambiarGramosPersona);
    el.accesoPicada.addEventListener('click', function () {
      cambiarModo(enPicada() ? 'venta' : 'picada');
    });
    el.btnSalirPicada.addEventListener('click', function () { cambiarModo('venta'); });
    el.btnPicadaNueva.addEventListener('click', nuevaPicada);
    pintarPicada();
    window.Scanner.onScan(porCodigo);
    decidirCamara();

    fetch('/api/config')
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.ok) estado.config = d.config; })
      .catch(function () {});

    el.chipEstacion.addEventListener('click', function () {
      cargarEstaciones().then(function () { abrirSelector(true); })
        .catch(function (e) { avisar('No se pudieron leer las estaciones: ' + e.message, 'error'); });
    });
    el.selectorCerrar.addEventListener('click', cerrarSelector);
    document.addEventListener('pointerdown', marcarActivo, true);
    document.addEventListener('keydown', marcarActivo, true);

    fetch('/api/medios-pago')
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.ok) { estado.medios = d.medios || []; pintarMedios(); } })
      .catch(function () {});

    cargarCatalogo();
    iniciarQr();
    cargarEstaciones()
      .then(decidirEstacion)
      .catch(function () { conectarWS(); }); // sin lista, la primera estacion
    pintarCarrito();
    mostrarVista('grupos');

    // Si vuelven de la pantalla de administracion, refrescamos el catalogo.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        cargarCatalogo();
        cargarEstaciones().then(pintarEstacion).catch(function () {});
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
