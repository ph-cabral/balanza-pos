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
    vista: 'grupos',
    ordenando: false,
    config: { venta: { avisarSiNoTara: true, umbralTaraKg: 0.02, segundosCarrito: 5 } },
    // Para detectar que se peso sin tarar: marcamos si la balanza volvio a cero.
    pasoPorCero: true,
    ultimoPesoCapturado: 0,
    cerrando: false,
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
  };

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    pesoNumero: $('pesoNumero'),
    chipEstado: $('chipEstado'),
    chipTexto: $('chipTexto'),
    chipPuerto: $('chipPuerto'),
    accionesSim: $('accionesSim'),
    buscador: $('buscador'),
    btnLimpiar: $('btnLimpiarBusqueda'),

    vistaGrupos: $('vistaGrupos'),
    vistaProductos: $('vistaProductos'),
    vistaConfirma: $('vistaConfirma'),

    grupos: $('grupos'),
    btnOrdenar: $('btnOrdenar'),
    columnas: $('columnas'),
    ayudaOrden: $('ayudaOrden'),
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

    el.accionesSim.hidden = !b.simulador;

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
    var libre = !estado.carrito.length && !estado.cerrando && Date.now() - ultimoToque > 20000;
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

  /** grupos | productos | confirma. Salir de "confirma" corta la vuelta automatica. */
  function mostrarVista(cual) {
    if (cual !== 'confirma') cancelarReloj();
    estado.vista = cual;
    el.vistaGrupos.hidden = cual !== 'grupos';
    el.vistaProductos.hidden = cual !== 'productos';
    el.vistaConfirma.hidden = cual !== 'confirma';
  }

  function volverAGrupos() {
    if (estado.filtro) {
      el.buscador.value = '';
      estado.filtro = '';
    }
    estado.grupoId = null;
    estado.itemConfirmado = null;
    modoOrdenar(false);
    mostrarVista('grupos');
  }

  function abrirGrupo(id) {
    estado.grupoId = id;
    mostrarVista('productos');
    pintarGrilla();
  }

  // ---------------------------------------------------------------- catalogo

  function cargarCatalogo() {
    return fetch('/api/productos')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error);
        estado.productos = d.productos;
        estado.grupos = d.categorias || [];
        // Si el grupo que estaba abierto se dio de baja, volvemos a la base.
        if (estado.grupoId && !grupoPorId(estado.grupoId)) estado.grupoId = null;
        pintarGrupos();
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
      if (f) return (p.nombre + ' ' + p.marca + ' ' + p.categoria).toLowerCase().indexOf(f) !== -1;
      return p.categoria_id === estado.grupoId;
    });
  }

  function pintarGrilla() {
    var lista = productosVisibles();
    var grupo = grupoPorId(estado.grupoId);

    el.tituloGrupo.textContent = estado.filtro.trim()
      ? 'Resultados de “' + estado.filtro.trim() + '”'
      : (grupo ? grupo.nombre : 'Productos');

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
    lista.forEach(function (p) {
      var b = document.createElement('button');
      b.className = 'prod';

      var arriba = document.createElement('div');
      var nom = document.createElement('div');
      nom.className = 'prod-nombre';
      nom.textContent = p.nombre;
      arriba.appendChild(nom);

      if (p.marca) {
        var ma = document.createElement('div');
        ma.className = 'prod-marca';
        ma.textContent = p.marca;
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
      b.addEventListener('click', function () { agregarProducto(p); });
      frag.appendChild(b);
    });
    el.grilla.appendChild(frag);
  }

  // ------------------------------------------------------- ordenar grupos

  /**
   * Arrastrar para acomodar los grupos.
   *
   * Fuera del modo ordenar, mantener apretado un grupo entra al modo (asi no se
   * desacomodan solos mientras se vende). Dentro del modo, el arrastre arranca
   * apenas se toca y los grupos dejan de tomar el gesto de scroll
   * (touch-action), que es lo que en una tablet corta el arrastre por la mitad.
   */
  function modoOrdenar(activo) {
    estado.ordenando = !!activo;
    el.grupos.classList.toggle('ordenando', estado.ordenando);
    el.btnOrdenar.textContent = estado.ordenando ? 'Listo' : 'Ordenar';
    el.btnOrdenar.classList.toggle('activo', estado.ordenando);
    el.ayudaOrden.textContent = estado.ordenando
      ? 'Arrastrá los grupos para acomodarlos'
      : 'Mantené apretado un grupo para acomodarlos';
  }

  function habilitarArrastre() {
    var cont = el.grupos;
    var hold = null;      // temporizador del "mantener apretado"
    var inicio = null;    // punto donde empezo el toque
    var arr = null;       // arrastre en curso
    var hueco = null;     // lugar que va a ocupar al soltar

    function cancelarHold() {
      if (hold) { clearTimeout(hold); hold = null; }
      inicio = null;
    }

    function ubicar(x, y) {
      arr.tile.style.transform =
        'translate(' + (x - arr.dx) + 'px,' + (y - arr.dy) + 'px) scale(1.04)';
    }

    function iniciar(tile, e) {
      var r = tile.getBoundingClientRect();
      arr = { tile: tile, dx: e.clientX - r.left, dy: e.clientY - r.top };

      hueco = document.createElement('div');
      hueco.className = 'grupo hueco';
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
      var destino = bajo && bajo.closest ? bajo.closest('.grupo') : null;
      if (!destino || destino === hueco || destino === arr.tile) return;

      var r = destino.getBoundingClientRect();
      var antes = e.clientX < r.left + r.width / 2;
      cont.insertBefore(hueco, antes ? destino : destino.nextSibling);
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

    cont.addEventListener('pointerdown', function (e) {
      var tile = e.target.closest ? e.target.closest('.grupo') : null;
      if (!tile || tile.classList.contains('hueco')) return;

      if (estado.ordenando) { iniciar(tile, e); return; }

      inicio = { x: e.clientX, y: e.clientY };
      hold = setTimeout(function () {
        hold = null;
        inicio = null;
        // Este toque solo entra al modo; el arrastre es el gesto siguiente.
        modoOrdenar(true);
        if (navigator.vibrate) { try { navigator.vibrate(15); } catch (err) {} }
      }, 450);
    });

    cont.addEventListener('pointermove', function (e) {
      if (inicio && (Math.abs(e.clientX - inicio.x) > 10 || Math.abs(e.clientY - inicio.y) > 10)) {
        cancelarHold();
      }
      if (arr) mover(e);
    });

    cont.addEventListener('pointerup', function () { cancelarHold(); soltar(); });
    cont.addEventListener('pointercancel', function () { cancelarHold(); soltar(); });
  }

  function guardarOrden() {
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

  // ---------------------------------------------------------------- carrito

  function subtotalDe(item) {
    return item.tipo === 'peso'
      ? Math.round((item.cantidad * item.precio_centavos) / 1000)
      : item.cantidad * item.precio_centavos;
  }

  function totalCarrito() {
    return estado.carrito.reduce(function (a, i) { return a + subtotalDe(i); }, 0);
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
    // Si ya esta en el carrito, sumamos una unidad en vez de duplicar la linea.
    var existente = null;
    for (var i = 0; i < estado.carrito.length; i++) {
      if (estado.carrito[i].producto_id === p.id && estado.carrito[i].tipo === 'unidad') {
        existente = estado.carrito[i];
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
      estado.carrito.push(existente);
    }
    pintarCarrito();
    mostrarConfirmacion(existente);
  }

  function agregarPorPeso(p) {
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
        estado.carrito.push(item);
        estado.ultimoPesoCapturado = gramos;
        estado.pasoPorCero = false;
        pintarCarrito();
        mostrarConfirmacion(item);

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
                pintarCarrito();
                if (estado.vista === 'confirma') pintarConfirmacion(item);
              },
            }
          );
        }
      })
      .catch(function (e) { avisar('Error al leer la balanza: ' + e.message, 'error'); });
  }

  function quitarItem(uid) {
    estado.carrito = estado.carrito.filter(function (i) { return i.uid !== uid; });
    pintarCarrito();
    if (estado.vista === 'confirma') {
      if (!estado.carrito.length) volverAGrupos();
      else pintarConfirmacion(null);
    }
  }

  function cambiarCantidad(uid, delta) {
    for (var i = 0; i < estado.carrito.length; i++) {
      if (estado.carrito[i].uid === uid) {
        estado.carrito[i].cantidad += delta;
        if (estado.carrito[i].cantidad <= 0) return quitarItem(uid);
        break;
      }
    }
    pintarCarrito();
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
      el.carritoContador.textContent = 'Sin artículos';
      el.total.textContent = plata(0);
      if (el.totalMini) el.totalMini.textContent = plata(0);
      el.btnCobrar.disabled = true;
      estado.ultimoPesoCapturado = 0;
      return;
    }

    var frag = document.createDocumentFragment();

    carrito.forEach(function (item) {
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
      det.textContent = detalleDe(item) + (item.marca ? ' · ' + item.marca : '');
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
      frag.appendChild(wrap);
    });

    el.carritoLista.appendChild(frag);

    el.carritoContador.textContent =
      carrito.length + (carrito.length === 1 ? ' artículo' : ' artículos');
    el.total.textContent = plata(totalCarrito());
    if (el.totalMini) el.totalMini.textContent = el.total.textContent;
    el.btnCobrar.disabled = estado.cerrando;
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
    var actual = estado.itemConfirmado;
    if (actual && estado.carrito.indexOf(actual) === -1) actual = estado.itemConfirmado = null;

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
    var resto = estado.carrito.filter(function (i) { return !actual || i.uid !== actual.uid; });
    if (resto.length) {
      var titulo = document.createElement('div');
      titulo.className = 'confirma-titulo';
      titulo.textContent = 'Resto de la venta';
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
    el.confirmaLista.appendChild(frag);

    el.confirmaTotal.textContent = plata(totalCarrito());
  }

  function segundosDeEspera() {
    var s = Number(estado.config.venta.segundosCarrito);
    return isFinite(s) && s > 0 ? s : 5;
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

    var nodo = item && el.carritoLista.querySelector('.item-wrap[data-uid="' + item.uid + '"]');
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

  function cerrarVenta() {
    if (!estado.carrito.length || estado.cerrando) return;

    estado.cerrando = true;
    el.btnCobrar.disabled = true;
    el.btnCobrarTexto.textContent = 'Guardando…';

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
      body: JSON.stringify({ items: items, estacion: estado.estacion }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error);
        avisar('Venta #' + d.venta.id + ' guardada · ' + plata(d.venta.total_centavos), 'ok');
        // Carrito limpio y pantalla de grupos, listo para la proxima.
        estado.carrito = [];
        estado.ultimoPesoCapturado = 0;
        estado.pasoPorCero = true;
        pintarCarrito();
        volverAGrupos();
        cerrarHoja();
      })
      .catch(function (e) {
        avisar('No se pudo guardar la venta: ' + e.message, 'error');
      })
      .finally(function () {
        estado.cerrando = false;
        el.btnCobrarTexto.textContent = 'Cerrar venta';
        el.btnCobrar.disabled = estado.carrito.length === 0;
      });
  }

  // ---------------------------------------------------------------- escaner

  function porCodigo(codigo) {
    fetch('/api/productos/codigo/' + encodeURIComponent(codigo))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) {
          avisar('Código ' + codigo + ' sin producto asociado', 'atencion');
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
    if (!el.grupos || !el.vistaConfirma || !el.btnSeguir || !el.selectorEstacion) {
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
        modoOrdenar(false);
        mostrarVista('productos');
        pintarGrilla();
      } else {
        volverAGrupos();
      }
    });

    el.btnLimpiar.addEventListener('click', function () {
      el.buscador.value = '';
      estado.filtro = '';
      el.buscador.blur();
      volverAGrupos();
    });

    el.btnVolver.addEventListener('click', volverAGrupos);
    el.btnSeguir.addEventListener('click', volverAGrupos);
    el.btnOrdenar.addEventListener('click', function () { modoOrdenar(!estado.ordenando); });
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

    el.btnCobrar.addEventListener('click', cerrarVenta);

    // Accesos a Ventas y Administrar. El carrito vive solo en esta pantalla:
    // con una venta a medio cargar no se sale sin avisar.
    document.querySelectorAll('.acceso').forEach(function (a) {
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

    el.accionesSim.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sim]');
      if (!b) return;
      fetch('/api/balanza/simular' + qEstacion(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gramos: Number(b.dataset.sim) }),
      });
    });

    habilitarArrastre();
    habilitarHoja();
    window.Scanner.onScan(porCodigo);

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

    cargarCatalogo();
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
