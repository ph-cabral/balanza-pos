/** Administracion: grupos, marcas, productos, importacion, balanza y ventas. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var estado = {
    productos: [], editando: null, ws: null,
    marcas: [], editandoMarca: null,
    grupos: [], editandoGrupo: null,
    categoriaFiltro: null,
  };

  var fmtPesos = new Intl.NumberFormat('es-AR', {
    style: 'currency', currency: 'ARS', minimumFractionDigits: 2,
  });
  function plata(c) { return fmtPesos.format((c || 0) / 100); }
  function kg(g) { return (g / 1000).toFixed(3).replace('.', ','); }

  // ------------------------------------------------------------- utilidades

  function avisar(texto, tipo) {
    var d = document.createElement('div');
    d.className = 'aviso ' + (tipo || '');
    d.innerHTML = '<div class="aviso-texto"></div>';
    d.firstChild.textContent = texto;
    $('avisos').appendChild(d);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 3000);
  }

  function api(url, opciones) {
    return fetch(url, opciones)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || 'Error desconocido');
        return d;
      });
  }

  /** Pesos con coma o punto -> centavos enteros. */
  function aCentavos(texto) {
    var n = parseFloat(String(texto).replace(/\./g, '.').replace(',', '.'));
    if (!isFinite(n)) return 0;
    return Math.round(n * 100);
  }

  // ------------------------------------------------------------- pestanas

  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('activa'); });
      t.classList.add('activa');
      var destino = t.dataset.tab;
      document.querySelectorAll('[data-panel]').forEach(function (p) {
        p.hidden = p.dataset.panel !== destino;
      });
      if (destino === 'grupos') cargarGrupos();
      if (destino === 'marcas') cargarMarcas();
      if (destino === 'ventas') cargarVentas();
      if (destino === 'balanza') {
        // No pisar un borrador con cambios sin guardar al volver a la pestaña.
        (sucio() ? Promise.resolve() : cargarEquipos()).then(buscarPuertos);
      }
    });
  });

  // ------------------------------------------------------------- grupos

  function cargarGrupos() {
    return api('/api/categorias/todas').then(function (d) {
      estado.grupos = d.categorias;
      pintarListaGrupos();
      pintarSelectGrupos();
      pintarChipsCategorias();
      pintarTabla();
    }).catch(function (e) { avisar(e.message, 'error'); });
  }

  /** Orden de un grupo dentro de la pantalla de venta (para ordenar el catalogo). */
  function ordenDeGrupo(nombre) {
    for (var i = 0; i < estado.grupos.length; i++) {
      if (estado.grupos[i].nombre === nombre) return i;
    }
    return 999;
  }

  function pintarListaGrupos() {
    var cont = $('listaGrupos');
    cont.innerHTML = '';

    if (!estado.grupos.length) {
      cont.innerHTML = '<div class="grupos-vacio">Todavía no hay grupos cargados.</div>';
      return;
    }

    var frag = document.createDocumentFragment();
    estado.grupos.forEach(function (g, i) {
      var fila = document.createElement('div');
      fila.className = 'fila-grupo' + (g.activo ? '' : ' inactivo');
      fila.draggable = !!g.activo;
      fila.dataset.id = g.id;

      var asa = document.createElement('span');
      asa.className = 'asa';
      asa.textContent = '⠿';
      asa.title = 'Arrastrar para reordenar';

      var ico = document.createElement('span');
      ico.className = 'fila-grupo-icono';
      ico.textContent = g.icono || '📦';

      var nom = document.createElement('div');
      nom.className = 'fila-grupo-nombre';
      nom.textContent = g.nombre + (g.activo ? '' : ' (de baja)');

      var cuenta = document.createElement('div');
      cuenta.className = 'fila-grupo-cuenta';
      cuenta.textContent = g.productos === 1 ? '1 producto' : g.productos + ' productos';

      var acc = document.createElement('div');
      acc.className = 'acciones-fila';

      var bSube = document.createElement('button');
      bSube.className = 'btn chico';
      bSube.textContent = '▲';
      bSube.disabled = i === 0;
      bSube.addEventListener('click', function () { moverGrupo(i, -1); });

      var bBaja = document.createElement('button');
      bBaja.className = 'btn chico';
      bBaja.textContent = '▼';
      bBaja.disabled = i === estado.grupos.length - 1;
      bBaja.addEventListener('click', function () { moverGrupo(i, 1); });

      var bEd = document.createElement('button');
      bEd.className = 'btn chico';
      bEd.textContent = 'Editar';
      bEd.addEventListener('click', function () { editarGrupo(g); });

      acc.appendChild(bSube);
      acc.appendChild(bBaja);
      acc.appendChild(bEd);

      if (g.activo) {
        var bOff = document.createElement('button');
        bOff.className = 'btn chico';
        bOff.textContent = 'Dar de baja';
        bOff.addEventListener('click', function () {
          if (!confirm('¿Dar de baja el grupo "' + g.nombre + '"? Deja de aparecer en la pantalla de venta. Los productos que tiene no se borran.')) return;
          api('/api/categorias/' + g.id, { method: 'DELETE' })
            .then(function () { avisar('Grupo dado de baja', 'ok'); return cargarGrupos(); })
            .catch(function (e) { avisar(e.message, 'error'); });
        });
        acc.appendChild(bOff);
      } else {
        var bOn = document.createElement('button');
        bOn.className = 'btn chico';
        bOn.textContent = 'Reactivar';
        bOn.addEventListener('click', function () {
          api('/api/categorias/' + g.id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activo: 1 }),
          }).then(cargarGrupos).catch(function (e) { avisar(e.message, 'error'); });
        });
        acc.appendChild(bOn);
      }

      fila.appendChild(asa);
      fila.appendChild(ico);
      fila.appendChild(nom);
      fila.appendChild(cuenta);
      fila.appendChild(acc);
      frag.appendChild(fila);
    });

    cont.appendChild(frag);
    habilitarArrastreGrupos(cont);
  }

  /** Arrastrar y soltar en la lista (mouse) - las flechas hacen lo mismo. */
  function habilitarArrastreGrupos(cont) {
    var origen = null;

    cont.addEventListener('dragstart', function (e) {
      origen = e.target.closest('.fila-grupo');
      if (origen) origen.classList.add('arrastrando');
    });

    cont.addEventListener('dragover', function (e) {
      if (!origen) return;
      e.preventDefault();
      var sobre = e.target.closest('.fila-grupo');
      if (!sobre || sobre === origen) return;
      var r = sobre.getBoundingClientRect();
      var antes = e.clientY < r.top + r.height / 2;
      cont.insertBefore(origen, antes ? sobre : sobre.nextSibling);
    });

    cont.addEventListener('drop', function (e) { e.preventDefault(); });

    cont.addEventListener('dragend', function () {
      if (!origen) return;
      origen.classList.remove('arrastrando');
      origen = null;
      var ids = [];
      cont.querySelectorAll('.fila-grupo').forEach(function (f) { ids.push(Number(f.dataset.id)); });
      guardarOrdenGrupos(ids);
    });
  }

  function moverGrupo(i, delta) {
    var j = i + delta;
    if (j < 0 || j >= estado.grupos.length) return;
    var copia = estado.grupos.slice();
    var tmp = copia[i];
    copia[i] = copia[j];
    copia[j] = tmp;
    guardarOrdenGrupos(copia.map(function (g) { return g.id; }));
  }

  function guardarOrdenGrupos(ids) {
    api('/api/categorias/orden', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids }),
    })
      .then(function () { return cargarGrupos(); })
      .catch(function (e) { avisar(e.message, 'error'); });
  }

  /** Llena el <select> de grupo del alta de producto. */
  function pintarSelectGrupos() {
    var sel = $('prodCategoria');
    var actual = sel.value;
    sel.innerHTML = '';
    estado.grupos.filter(function (g) { return g.activo; }).forEach(function (g) {
      var o = document.createElement('option');
      o.value = g.id;
      o.textContent = g.nombre;
      sel.appendChild(o);
    });
    if (actual) sel.value = actual;
  }

  function editarGrupo(g) {
    estado.editandoGrupo = g.id;
    $('grupoId').value = g.id;
    $('grupoNombre').value = g.nombre;
    $('grupoIcono').value = g.icono || '';
    marcarIcono();
    $('formTituloGrupo').textContent = 'Editando: ' + g.nombre;
    $('btnGuardarGrupo').textContent = 'Guardar cambios';
    $('btnCancelarGrupo').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function limpiarFormGrupo() {
    estado.editandoGrupo = null;
    $('formGrupo').reset();
    $('grupoId').value = '';
    marcarIcono();
    $('formTituloGrupo').textContent = 'Nuevo grupo';
    $('btnGuardarGrupo').textContent = 'Guardar grupo';
    $('btnCancelarGrupo').hidden = true;
  }

  // Iconos a mano para elegir con un toque; igual se puede pegar cualquier emoji.
  var ICONOS = ['🍖', '🧀', '🌭', '🥓', '🥩', '🍗', '🥛', '🍯', '🥚', '🍞', '🍝', '🥫',
                '🥤', '🧃', '💧', '🍺', '🍷', '🥂', '☕', '🍫', '🍬', '🍪', '🍿', '🥜',
                '🍎', '🥕', '🧊', '🛒', '🧴', '🧻', '📦', '⭐'];

  function marcarIcono() {
    var actual = $('grupoIcono').value.trim();
    $('iconosSugeridos').querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('activo', b.textContent === actual);
    });
  }

  (function pintarIconos() {
    var cont = $('iconosSugeridos');
    ICONOS.forEach(function (ic) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = ic;
      b.addEventListener('click', function () {
        $('grupoIcono').value = $('grupoIcono').value.trim() === ic ? '' : ic;
        marcarIcono();
      });
      cont.appendChild(b);
    });
    $('grupoIcono').addEventListener('input', marcarIcono);
  })();

  $('btnCancelarGrupo').addEventListener('click', limpiarFormGrupo);

  $('formGrupo').addEventListener('submit', function (e) {
    e.preventDefault();
    var url = estado.editandoGrupo ? '/api/categorias/' + estado.editandoGrupo : '/api/categorias';

    api(url, {
      method: estado.editandoGrupo ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: $('grupoNombre').value, icono: $('grupoIcono').value }),
    })
      .then(function () {
        avisar(estado.editandoGrupo ? 'Grupo actualizado' : 'Grupo agregado', 'ok');
        limpiarFormGrupo();
        return cargarGrupos();
      })
      .then(function () { return cargarProductos(); })
      .catch(function (err) { avisar(err.message, 'error'); });
  });

  // ------------------------------------------------------------- marcas

  function cargarMarcas() {
    return api('/api/marcas/todas').then(function (d) {
      estado.marcas = d.marcas;
      pintarTablaMarcas();
      pintarSelectMarcas();
    }).catch(function (e) { avisar(e.message, 'error'); });
  }

  function pintarTablaMarcas() {
    var tbody = $('tablaMarcas');
    tbody.innerHTML = '';

    if (!estado.marcas.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--texto-tenue);padding:28px">' +
        'Todavía no hay marcas cargadas.</td></tr>';
      return;
    }

    var frag = document.createDocumentFragment();
    estado.marcas.forEach(function (m) {
      var tr = document.createElement('tr');
      if (!m.activo) tr.className = 'inactivo';

      var tdNombre = document.createElement('td');
      tdNombre.textContent = m.nombre;

      var tdProductos = document.createElement('td');
      tdProductos.className = 'der num';
      tdProductos.textContent = m.productos;

      var tdAcc = document.createElement('td');
      tdAcc.className = 'der';
      var wrap = document.createElement('div');
      wrap.className = 'acciones-fila';

      var bEd = document.createElement('button');
      bEd.className = 'btn chico';
      bEd.textContent = 'Editar';
      bEd.addEventListener('click', function () { editarMarca(m); });
      wrap.appendChild(bEd);

      if (m.activo) {
        var bBaja = document.createElement('button');
        bBaja.className = 'btn chico';
        bBaja.textContent = 'Dar de baja';
        bBaja.addEventListener('click', function () {
          if (!confirm('¿Dar de baja "' + m.nombre + '"? Deja de ofrecerse para productos nuevos.')) return;
          api('/api/marcas/' + m.id, { method: 'DELETE' })
            .then(function () { avisar('Marca dada de baja', 'ok'); return cargarMarcas(); })
            .catch(function (e) { avisar(e.message, 'error'); });
        });
        wrap.appendChild(bBaja);
      } else {
        var bAlta = document.createElement('button');
        bAlta.className = 'btn chico';
        bAlta.textContent = 'Reactivar';
        bAlta.addEventListener('click', function () {
          api('/api/marcas/' + m.id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activo: 1 }),
          }).then(cargarMarcas);
        });
        wrap.appendChild(bAlta);
      }

      tdAcc.appendChild(wrap);
      [tdNombre, tdProductos, tdAcc].forEach(function (td) { tr.appendChild(td); });
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  /** Llena el <select> de marca del alta de producto con las marcas activas. */
  function pintarSelectMarcas() {
    var sel = $('prodMarca');
    var actual = sel.value;
    sel.innerHTML = '<option value="">— Sin marca —</option>';
    estado.marcas.filter(function (m) { return m.activo; }).forEach(function (m) {
      var o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.nombre;
      sel.appendChild(o);
    });
    if (actual) sel.value = actual;
  }

  function editarMarca(m) {
    estado.editandoMarca = m.id;
    $('marcaId').value = m.id;
    $('marcaNombre').value = m.nombre;
    $('formTituloMarca').textContent = 'Editando: ' + m.nombre;
    $('btnGuardarMarca').textContent = 'Guardar cambios';
    $('btnCancelarMarca').hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function limpiarFormMarca() {
    estado.editandoMarca = null;
    $('formMarca').reset();
    $('marcaId').value = '';
    $('formTituloMarca').textContent = 'Nueva marca';
    $('btnGuardarMarca').textContent = 'Guardar marca';
    $('btnCancelarMarca').hidden = true;
  }

  $('btnCancelarMarca').addEventListener('click', limpiarFormMarca);

  $('formMarca').addEventListener('submit', function (e) {
    e.preventDefault();
    var cuerpo = { nombre: $('marcaNombre').value };
    var url = estado.editandoMarca ? '/api/marcas/' + estado.editandoMarca : '/api/marcas';
    var metodo = estado.editandoMarca ? 'PUT' : 'POST';

    api(url, {
      method: metodo,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    })
      .then(function () {
        avisar(estado.editandoMarca ? 'Marca actualizada' : 'Marca agregada', 'ok');
        limpiarFormMarca();
        return cargarMarcas();
      })
      .catch(function (err) { avisar(err.message, 'error'); });
  });

  // ------------------------------------------------------------- productos

  function cargarProductos() {
    return api('/api/productos/todos').then(function (d) {
      estado.productos = d.productos;
      pintarTabla();
      pintarChipsCategorias();
    }).catch(function (e) { avisar(e.message, 'error'); });
  }

  /** Chips de grupo (quesos, jamones, gaseosas...) para filtrar el catalogo. */
  function pintarChipsCategorias() {
    var verInactivos = $('verInactivos').checked;
    var conteos = {};
    estado.productos.forEach(function (p) {
      if (!verInactivos && !p.activo) return;
      conteos[p.categoria] = (conteos[p.categoria] || 0) + 1;
    });

    var cont = $('chipsCategorias');
    cont.innerHTML = '';
    // En el mismo orden que la pantalla de venta.
    Object.keys(conteos).sort(function (a, b) {
      return ordenDeGrupo(a) - ordenDeGrupo(b) || a.localeCompare(b, 'es');
    }).forEach(function (cat) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip-cat' + (estado.categoriaFiltro === cat ? ' activo' : '');
      b.innerHTML = '<span></span><span class="n"></span>';
      b.children[0].textContent = cat;
      b.children[1].textContent = ' · ' + conteos[cat];
      b.addEventListener('click', function () {
        estado.categoriaFiltro = estado.categoriaFiltro === cat ? null : cat;
        pintarChipsCategorias();
        pintarTabla();
      });
      cont.appendChild(b);
    });
  }

  function pintarTabla() {
    var filtro = $('filtroProductos').value.toLowerCase().trim();
    var verInactivos = $('verInactivos').checked;
    var tbody = $('tablaProductos');
    tbody.innerHTML = '';

    var lista = estado.productos.filter(function (p) {
      if (!verInactivos && !p.activo) return false;
      if (estado.categoriaFiltro && p.categoria !== estado.categoriaFiltro) return false;
      if (!filtro) return true;
      return (p.nombre + ' ' + p.marca + ' ' + p.categoria + ' ' + (p.codigo_barras || ''))
        .toLowerCase().indexOf(filtro) !== -1;
    });

    if (!lista.length) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="6" style="text-align:center;color:var(--texto-tenue);padding:28px">' +
        (estado.productos.length ? 'Sin coincidencias.' : 'Todavía no hay productos cargados.') + '</td>';
      tbody.appendChild(tr);
      return;
    }

    // Se ordena por grupo (en el orden de la pantalla de venta) y despues por
    // nombre; una fila separadora por grupo deja el catalogo agrupado.
    lista.sort(function (a, b) {
      return ordenDeGrupo(a.categoria) - ordenDeGrupo(b.categoria) ||
        a.categoria.localeCompare(b.categoria, 'es') ||
        a.nombre.localeCompare(b.nombre, 'es');
    });

    var frag = document.createDocumentFragment();
    var categoriaAnterior = null;
    lista.forEach(function (p) {
      if (p.categoria !== categoriaAnterior) {
        categoriaAnterior = p.categoria;
        var trCat = document.createElement('tr');
        trCat.className = 'fila-categoria';
        trCat.innerHTML = '<td colspan="6"></td>';
        trCat.firstChild.textContent = p.categoria;
        frag.appendChild(trCat);
      }

      var tr = document.createElement('tr');
      if (!p.activo) tr.className = 'inactivo';

      var tdNombre = document.createElement('td');
      tdNombre.textContent = p.nombre;

      var tdMarca = document.createElement('td');
      tdMarca.textContent = p.marca || '—';

      var tdTipo = document.createElement('td');
      tdTipo.innerHTML = '<span class="pill ' + p.tipo + '">' +
        (p.tipo === 'peso' ? 'por kg' : 'unidad') + '</span>';

      var tdCod = document.createElement('td');
      tdCod.style.fontFamily = 'ui-monospace, Consolas, monospace';
      tdCod.style.fontSize = '13px';
      tdCod.textContent = p.codigo_barras || '—';

      var tdPrecio = document.createElement('td');
      tdPrecio.className = 'der num';
      tdPrecio.textContent = plata(p.precio_centavos);

      var tdAcc = document.createElement('td');
      tdAcc.className = 'der';
      var wrap = document.createElement('div');
      wrap.className = 'acciones-fila';

      var bEd = document.createElement('button');
      bEd.className = 'btn chico';
      bEd.textContent = 'Editar';
      bEd.addEventListener('click', function () { editar(p); });
      wrap.appendChild(bEd);

      if (p.activo) {
        var bBaja = document.createElement('button');
        bBaja.className = 'btn chico';
        bBaja.textContent = 'Dar de baja';
        bBaja.addEventListener('click', function () { darDeBaja(p); });
        wrap.appendChild(bBaja);
      } else {
        var bAlta = document.createElement('button');
        bAlta.className = 'btn chico';
        bAlta.textContent = 'Reactivar';
        bAlta.addEventListener('click', function () {
          api('/api/productos/' + p.id, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activo: 1 }),
          }).then(cargarProductos);
        });
        wrap.appendChild(bAlta);
      }

      tdAcc.appendChild(wrap);
      [tdNombre, tdMarca, tdTipo, tdCod, tdPrecio, tdAcc].forEach(function (td) { tr.appendChild(td); });
      frag.appendChild(tr);
    });
    tbody.appendChild(frag);
  }

  function editar(p) {
    estado.editando = p.id;
    $('prodId').value = p.id;
    $('prodNombre').value = p.nombre;
    // Si la marca del producto fue dada de baja, no aparece en el <select>
    // (solo lista activas): se agrega igual para no perderla al editar.
    if (p.marca_id && !estado.marcas.some(function (m) { return m.id === p.marca_id; })) {
      var o = document.createElement('option');
      o.value = p.marca_id;
      o.textContent = p.marca + ' (de baja)';
      $('prodMarca').appendChild(o);
    }
    $('prodMarca').value = p.marca_id || '';
    // Si el grupo del producto fue dado de baja, no esta en el <select>: se
    // agrega igual para no cambiarlo sin querer al editar.
    if (p.categoria_id && !estado.grupos.some(function (g) { return g.id === p.categoria_id && g.activo; })) {
      var og = document.createElement('option');
      og.value = p.categoria_id;
      og.textContent = p.categoria + ' (de baja)';
      $('prodCategoria').appendChild(og);
    }
    $('prodCategoria').value = p.categoria_id || '';
    $('prodTipo').value = p.tipo;
    $('prodPrecio').value = (p.precio_centavos / 100).toFixed(2);
    $('prodCodigo').value = p.codigo_barras || '';
    $('formTitulo').textContent = 'Editando: ' + p.nombre;
    $('btnGuardar').textContent = 'Guardar cambios';
    $('btnCancelar').hidden = false;
    actualizarLabelPrecio();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function limpiarForm() {
    estado.editando = null;
    $('formProducto').reset();
    $('prodId').value = '';
    $('formTitulo').textContent = 'Nuevo producto';
    $('btnGuardar').textContent = 'Guardar producto';
    $('btnCancelar').hidden = true;
    actualizarLabelPrecio();
  }

  function darDeBaja(p) {
    if (!confirm('¿Dar de baja "' + p.nombre + '"? Deja de aparecer en el punto de venta.')) return;
    api('/api/productos/' + p.id, { method: 'DELETE' })
      .then(function () { avisar('Producto dado de baja', 'ok'); return cargarProductos(); })
      .catch(function (e) { avisar(e.message, 'error'); });
  }

  function actualizarLabelPrecio() {
    $('lblPrecio').textContent = $('prodTipo').value === 'peso' ? 'por kg' : 'por unidad';
  }

  $('prodTipo').addEventListener('change', actualizarLabelPrecio);
  $('filtroProductos').addEventListener('input', pintarTabla);
  $('verInactivos').addEventListener('change', function () { pintarChipsCategorias(); pintarTabla(); });
  $('btnCancelar').addEventListener('click', limpiarForm);

  $('formProducto').addEventListener('submit', function (e) {
    e.preventDefault();
    var cuerpo = {
      nombre: $('prodNombre').value,
      marca_id: $('prodMarca').value || null,
      categoria_id: $('prodCategoria').value || null,
      tipo: $('prodTipo').value,
      precio_centavos: aCentavos($('prodPrecio').value),
      codigo_barras: $('prodCodigo').value,
      activo: 1,
    };

    var url = estado.editando ? '/api/productos/' + estado.editando : '/api/productos';
    var metodo = estado.editando ? 'PUT' : 'POST';

    api(url, {
      method: metodo,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    })
      .then(function () {
        avisar(estado.editando ? 'Producto actualizado' : 'Producto agregado', 'ok');
        limpiarForm();
        return cargarProductos();
      })
      .catch(function (err) { avisar(err.message, 'error'); });
  });

  // ------------------------------------------------------------- importar

  function parsearCSV(texto) {
    var filas = texto.split(/\r?\n/).filter(function (l) { return l.trim(); });
    var salida = [];

    filas.forEach(function (linea, i) {
      var cols = linea.split(/[;\t]/).map(function (c) { return c.trim(); });
      // Salteamos el encabezado si la primera fila no tiene precio numerico.
      if (i === 0 && (/nombre/i.test(cols[0]) || !isFinite(parseFloat((cols[4] || '').replace(',', '.'))))) {
        if (/nombre/i.test(cols[0])) return;
      }
      if (!cols[0]) return;
      salida.push({
        nombre: cols[0],
        marca: cols[1] || '',
        categoria: cols[2] || '',
        tipo: (cols[3] || 'peso').toLowerCase() === 'unidad' ? 'unidad' : 'peso',
        precio_centavos: aCentavos(cols[4] || '0'),
        codigo_barras: cols[5] || null,
        activo: 1,
      });
    });

    return salida;
  }

  $('btnPrevisualizar').addEventListener('click', function () {
    var lista = parsearCSV($('csv').value);
    var previa = $('previa');
    previa.hidden = false;
    if (!lista.length) { previa.textContent = 'No se detectó ninguna fila válida.'; return; }
    previa.textContent = lista.length + ' producto(s) detectado(s):\n\n' +
      lista.map(function (p) {
        return '· ' + p.nombre + (p.marca ? ' (' + p.marca + ')' : '') +
          ' — ' + p.categoria + ' — ' + (p.tipo === 'peso' ? 'por kg' : 'unidad') +
          ' — ' + plata(p.precio_centavos) + (p.codigo_barras ? ' — ' + p.codigo_barras : '');
      }).join('\n');
  });

  $('btnImportar').addEventListener('click', function () {
    var lista = parsearCSV($('csv').value);
    if (!lista.length) return avisar('No se detectó ninguna fila válida', 'atencion');
    if (!confirm('Se van a importar ' + lista.length + ' producto(s). ¿Continuar?')) return;

    api('/api/productos/importar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productos: lista }),
    })
      .then(function (d) {
        avisar(d.creados + ' producto(s) importado(s)', 'ok');
        $('csv').value = '';
        $('previa').hidden = true;
        // La planilla puede haber traído grupos nuevos.
        return cargarGrupos().then(cargarProductos);
      })
      .catch(function (e) { avisar(e.message, 'error'); });
  });

  // ------------------------------------------------------------- estaciones

  // Borrador local de balanzas, escaneres y estaciones: se edita en pantalla y
  // se manda todo junto con "Guardar y reconectar". El estado en vivo de cada
  // equipo llega por WebSocket y se pinta aparte, sin tocar los formularios.
  var eq = {
    guardado: null,     // lo ultimo que devolvio el servidor (sin estado)
    borrador: null,
    vivos: { balanza: {}, escaner: {} },
    puertos: [],
  };

  var PROTOCOLOS = ['auto', 'kretz', 'toledo', 'flagCorto', 'etiquetado', 'soloPeso', 'generico'];
  var VELOCIDADES = ['1200', '2400', '4800', '9600', '19200', '38400', '57600', '115200'];

  function sinEstado(lista) {
    return lista.map(function (x) {
      var c = {};
      Object.keys(x).forEach(function (k) { if (k !== 'estado') c[k] = x[k]; });
      return c;
    });
  }

  function copia(o) { return JSON.parse(JSON.stringify(o)); }

  function cargarEquipos() {
    return api('/api/dispositivos').then(function (d) {
      d.balanzas.forEach(function (b) { if (b.estado) eq.vivos.balanza[b.id] = b.estado; });
      d.escaneres.forEach(function (s) { if (s.estado) eq.vivos.escaner[s.id] = s.estado; });
      eq.guardado = {
        balanzas: sinEstado(d.balanzas),
        escaneres: sinEstado(d.escaneres),
        estaciones: d.estaciones.map(function (e) {
          return { id: e.id, nombre: e.nombre, balanza: e.balanza, escaner: e.escaner };
        }),
      };
      eq.borrador = copia(eq.guardado);
      pintarEquipos();
    }).catch(function (e) { avisar(e.message, 'error'); });
  }

  function sucio() {
    return eq.borrador && JSON.stringify(eq.borrador) !== JSON.stringify(eq.guardado);
  }

  function pintarBarraGuardar() {
    var s = sucio();
    $('barraGuardar').classList.toggle('sucio', !!s);
    $('estadoGuardado').textContent = s ? 'Hay cambios sin guardar' : 'Sin cambios';
    $('btnGuardarEquipos').disabled = !s;
    $('btnDescartar').disabled = !s;
  }

  function idLibre(prefijo, lista) {
    var usados = {};
    lista.forEach(function (x) { usados[x.id] = true; });
    for (var n = 1; ; n++) if (!usados[prefijo + n]) return prefijo + n;
  }

  // --- pequeños constructores de formulario

  function campo(etiqueta, control) {
    var d = document.createElement('div');
    d.className = 'campo';
    var l = document.createElement('label');
    l.textContent = etiqueta;
    d.appendChild(l);
    d.appendChild(control);
    return d;
  }

  function entrada(obj, clave, opciones) {
    opciones = opciones || {};
    var i = document.createElement('input');
    i.value = obj[clave] == null ? '' : obj[clave];
    if (opciones.placeholder) i.placeholder = opciones.placeholder;
    if (opciones.list) i.setAttribute('list', opciones.list);
    i.dataset.campo = clave;
    i.addEventListener('input', function () { obj[clave] = i.value.trim(); pintarBarraGuardar(); });
    if (opciones.alCambiar) i.addEventListener('change', opciones.alCambiar);
    return i;
  }

  function selector(obj, clave, valores, opciones) {
    opciones = opciones || {};
    var s = document.createElement('select');
    s.dataset.campo = clave;
    valores.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v.valor;
      o.textContent = v.texto;
      s.appendChild(o);
    });
    s.value = obj[clave] == null ? '' : String(obj[clave]);
    s.addEventListener('change', function () {
      var v = s.value;
      if (opciones.numero) v = Number(v);
      if (opciones.nulo && v === '') v = null;
      obj[clave] = v;
      pintarBarraGuardar();
      if (opciones.alCambiar) opciones.alCambiar();
    });
    return s;
  }

  function interruptor(obj, clave, texto, alCambiar) {
    var d = document.createElement('div');
    d.className = 'switch';
    var i = document.createElement('input');
    i.type = 'checkbox';
    i.id = 'sw-' + obj.id + '-' + clave;
    i.checked = !!obj[clave];
    i.addEventListener('change', function () {
      obj[clave] = i.checked;
      pintarBarraGuardar();
      if (alCambiar) alCambiar();
    });
    var l = document.createElement('label');
    l.htmlFor = i.id;
    l.textContent = texto;
    d.appendChild(i);
    d.appendChild(l);
    return d;
  }

  function botonQuitar(texto, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn chico quitar';
    b.textContent = texto;
    b.addEventListener('click', fn);
    return b;
  }

  function opcionesDe(lista, vacio) {
    return [{ valor: '', texto: vacio }].concat(lista.map(function (x) {
      return { valor: x.id, texto: x.nombre };
    }));
  }

  // --- listas

  function pintarEquipos() {
    if (!eq.borrador) return;
    pintarEstaciones();
    pintarBalanzas();
    pintarEscaneres();
    pintarSelectDiagnostico();
    pintarTablaPuertos();
    pintarBarraGuardar();
  }

  function pintarEstaciones() {
    var cont = $('listaEstaciones');
    cont.innerHTML = '';
    var b = eq.borrador;
    b.estaciones.forEach(function (e, i) {
      var fila = document.createElement('div');
      fila.className = 'fila-estacion';
      fila.dataset.id = e.id;
      fila.appendChild(campo('Estación', entrada(e, 'nombre', { placeholder: 'Mostrador ' + (i + 1) })));
      fila.appendChild(campo('Balanza', selector(e, 'balanza', opcionesDe(b.balanzas, 'Sin balanza'), { nulo: true })));
      fila.appendChild(campo('Escáner', selector(e, 'escaner', opcionesDe(b.escaneres, 'Sin escáner'), { nulo: true })));
      var q = botonQuitar('Quitar', function () {
        if (b.estaciones.length <= 1) { avisar('Tiene que quedar al menos una estación', 'error'); return; }
        b.estaciones.splice(b.estaciones.indexOf(e), 1);
        pintarEquipos();
      });
      q.style.height = '46px';
      fila.appendChild(q);
      cont.appendChild(fila);
    });
  }

  function cabeceraEquipo(tipo, x, lista) {
    var cab = document.createElement('div');
    cab.className = 'equipo-cab';
    var viv = document.createElement('span');
    viv.className = 'estado-vivo';
    viv.dataset.vivo = tipo + ':' + x.id;
    cab.appendChild(viv);
    var id = document.createElement('span');
    id.className = 'equipo-id';
    id.textContent = x.id;
    cab.appendChild(id);
    cab.appendChild(botonQuitar('Quitar', function () {
      var usadaEn = eq.borrador.estaciones.filter(function (e) { return e[tipo] === x.id; });
      lista.splice(lista.indexOf(x), 1);
      // La estacion que la usaba queda sin ese equipo.
      usadaEn.forEach(function (e) { e[tipo] = null; });
      pintarEquipos();
    }));
    return cab;
  }

  function camposPuerto(x) {
    return [
      campo('Puerto', entrada(x, 'puerto', { placeholder: 'COM…', list: 'listaPuertos' })),
      campo('N° de serie del adaptador', entrada(x, 'numeroSerie', { placeholder: 'opcional', list: 'listaSeries' })),
      campo('Velocidad', selector(x, 'baudRate', VELOCIDADES.map(function (v) { return { valor: v, texto: v }; }), { numero: true })),
      campo('Paridad', selector(x, 'parity', ['none', 'even', 'odd'].map(function (v) { return { valor: v, texto: v }; }))),
      campo('Bits de stop', selector(x, 'stopBits', [{ valor: '1', texto: '1' }, { valor: '2', texto: '2' }], { numero: true })),
    ];
  }

  function pintarBalanzas() {
    var cont = $('listaBalanzas');
    cont.innerHTML = '';
    var lista = eq.borrador.balanzas;
    lista.forEach(function (x) {
      var card = document.createElement('div');
      card.className = 'equipo';
      card.dataset.id = x.id;
      card.appendChild(cabeceraEquipo('balanza', x, lista));
      var g = document.createElement('div');
      g.className = 'form-grilla';
      g.appendChild(campo('Nombre', entrada(x, 'nombre', { alCambiar: function () { pintarEstaciones(); pintarSelectDiagnostico(); } })));
      g.appendChild(interruptor(x, 'simulador', 'Modo simulador'));
      camposPuerto(x).forEach(function (c) { g.appendChild(c); });
      g.appendChild(campo('Protocolo', selector(x, 'protocolo', PROTOCOLOS.map(function (v) {
        return { valor: v, texto: v === 'auto' ? 'Detectar solo' : v };
      }))));
      card.appendChild(g);
      var det = document.createElement('div');
      det.className = 'estado-detalle';
      det.dataset.detalle = 'balanza:' + x.id;
      card.appendChild(det);
      cont.appendChild(card);
      pintarVivo('balanza', x.id);
    });
  }

  function pintarEscaneres() {
    var cont = $('listaEscaneres');
    cont.innerHTML = '';
    var lista = eq.borrador.escaneres;
    lista.forEach(function (x) {
      var card = document.createElement('div');
      card.className = 'equipo';
      card.dataset.id = x.id;
      card.appendChild(cabeceraEquipo('escaner', x, lista));
      var g = document.createElement('div');
      g.className = 'form-grilla';
      g.appendChild(campo('Nombre', entrada(x, 'nombre', { alCambiar: pintarEstaciones })));
      g.appendChild(interruptor(x, 'simulador', 'Modo simulador'));
      camposPuerto(x).forEach(function (c) { g.appendChild(c); });
      card.appendChild(g);

      var det = document.createElement('div');
      det.className = 'estado-detalle';
      det.dataset.detalle = 'escaner:' + x.id;
      card.appendChild(det);

      // Mandar un codigo de prueba como si lo hubiera leido este escaner: sirve
      // para ver que llega a la estacion correcta sin tener el equipo.
      var pr = document.createElement('div');
      pr.className = 'probar-codigo';
      var inp = document.createElement('input');
      inp.placeholder = 'Código de prueba (ej. 7790001000017)';
      var bt = document.createElement('button');
      bt.type = 'button';
      bt.className = 'btn chico';
      bt.textContent = 'Enviar a su estación';
      bt.addEventListener('click', function () {
        var codigo = inp.value.trim();
        if (!codigo) { avisar('Escribí un código', 'error'); return; }
        api('/api/escaner/simular', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ escaner: x.id, codigo: codigo }),
        }).then(function () { avisar('Código enviado', 'ok'); })
          .catch(function (e) { avisar(e.message + (sucio() ? ' (¿falta guardar?)' : ''), 'error'); });
      });
      pr.appendChild(inp);
      pr.appendChild(bt);
      card.appendChild(pr);
      cont.appendChild(card);
      pintarVivo('escaner', x.id);
    });
  }

  function pintarVivo(tipo, id) {
    var v = eq.vivos[tipo][id];
    var nodo = document.querySelector('[data-vivo="' + tipo + ':' + id + '"]');
    var det = document.querySelector('[data-detalle="' + tipo + ':' + id + '"]');
    if (!nodo) return;
    var clase = 'estado-vivo ';
    var texto;
    if (!v) { texto = 'Sin guardar'; }
    else if (!v.conectado) { clase += 'mal'; texto = 'Desconectado'; }
    else if (tipo === 'balanza') {
      clase += v.estable ? 'ok' : 'espera';
      texto = kg(v.gramos || 0) + ' kg' + (v.estable ? '' : ' · estabilizando');
    } else { clase += 'ok'; texto = 'Conectado'; }
    nodo.className = clase;
    nodo.innerHTML = '<span class="punto"></span>';
    nodo.appendChild(document.createTextNode(texto));
    if (det) {
      var partes = [];
      if (v) {
        if (v.simulador) partes.push('Simulador');
        else if (v.puerto) partes.push('Puerto ' + v.puerto);
        if (tipo === 'escaner' && v.ultimoCodigo) {
          partes.push('Último código: ' + v.ultimoCodigo + ' (' + new Date(v.ultimoEn).toLocaleTimeString('es-AR') + ')');
        }
        if (v.error) partes.push(v.error);
      }
      det.textContent = partes.join(' · ');
    }
  }

  // --- puertos

  function buscarPuertos() {
    return api('/api/puertos').then(function (d) {
      eq.puertos = d.puertos || [];
      var dl = $('listaPuertos');
      var ds = $('listaSeries');
      dl.innerHTML = '';
      ds.innerHTML = '';
      eq.puertos.forEach(function (p) {
        var o = document.createElement('option');
        o.value = p.path;
        o.label = p.fabricante + (p.numeroSerie ? ' · ' + p.numeroSerie : '');
        dl.appendChild(o);
        if (p.numeroSerie) {
          var o2 = document.createElement('option');
          o2.value = p.numeroSerie;
          o2.label = p.path + ' · ' + p.fabricante;
          ds.appendChild(o2);
        }
      });
      pintarTablaPuertos();
      if (d.aviso) avisar(d.aviso, 'error');
    }).catch(function (e) { avisar(e.message, 'error'); });
  }

  function pintarTablaPuertos() {
    var tbody = $('tablaPuertos');
    if (!tbody || !eq.borrador) return;
    tbody.innerHTML = '';
    if (!eq.puertos.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="vacio">Esta PC no ve ningún puerto COM (o todavía no se buscó).</td></tr>';
      return;
    }
    var equipos = eq.borrador.balanzas.map(function (b) { return { tipo: 'balanza', x: b }; })
      .concat(eq.borrador.escaneres.map(function (s) { return { tipo: 'escaner', x: s }; }));
    eq.puertos.forEach(function (p) {
      var tr = document.createElement('tr');
      var celdas = [p.path, p.fabricante || '—', p.numeroSerie || '—',
        p.vendorId ? p.vendorId + ':' + (p.productId || '?') : '—', p.usadoPor || '—'];
      celdas.forEach(function (t, i) {
        var td = document.createElement('td');
        td.textContent = t;
        if (i === 0 || i === 2 || i === 3) td.className = 'num';
        tr.appendChild(td);
      });
      var td = document.createElement('td');
      td.className = 'der';
      var s = document.createElement('select');
      s.className = 'asignar';
      s.innerHTML = '<option value="">Asignar a…</option>';
      equipos.forEach(function (e, i) {
        var o = document.createElement('option');
        o.value = String(i);
        o.textContent = (e.tipo === 'balanza' ? '⚖️ ' : '▥ ') + e.x.nombre;
        s.appendChild(o);
      });
      s.addEventListener('change', function () {
        if (s.value === '') return;
        var e = equipos[Number(s.value)];
        e.x.puerto = p.path;
        e.x.numeroSerie = p.numeroSerie || '';
        e.x.simulador = false;
        pintarEquipos();
        avisar(p.path + ' asignado a ' + e.x.nombre + '. Falta guardar.', 'ok');
      });
      td.appendChild(s);
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
  }

  // --- alta, guardar, descartar

  $('btnAgregarEstacion').addEventListener('click', function () {
    var b = eq.borrador;
    var n = b.estaciones.length + 1;
    // Por comodidad se le asigna la primera balanza y el primer escaner libres.
    var usadasB = b.estaciones.map(function (e) { return e.balanza; });
    var usadosS = b.estaciones.map(function (e) { return e.escaner; });
    var libreB = b.balanzas.filter(function (x) { return usadasB.indexOf(x.id) === -1; })[0];
    var libreS = b.escaneres.filter(function (x) { return usadosS.indexOf(x.id) === -1; })[0];
    b.estaciones.push({
      id: idLibre('e', b.estaciones),
      nombre: 'Mostrador ' + n,
      balanza: libreB ? libreB.id : null,
      escaner: libreS ? libreS.id : null,
    });
    pintarEquipos();
  });

  $('btnAgregarBalanza').addEventListener('click', function () {
    var lista = eq.borrador.balanzas;
    var base = lista[0] || {};
    lista.push({
      id: idLibre('b', lista.concat(eq.borrador.escaneres)),
      nombre: 'Balanza ' + (lista.length + 1),
      simulador: true,
      puerto: '',
      numeroSerie: '',
      // Mismos parametros que la primera (misma marca y modelo, normalmente).
      baudRate: base.baudRate || 9600,
      dataBits: base.dataBits || 8,
      parity: base.parity || 'none',
      stopBits: base.stopBits || 2,
      protocolo: base.protocolo || 'kretz',
      autodeteccion: true,
      lecturasParaEstable: base.lecturasParaEstable || 4,
      toleranciaEstabilidadKg: base.toleranciaEstabilidadKg || 0.002,
      pesoMinimoKg: base.pesoMinimoKg || 0.005,
      broadcastHz: base.broadcastHz || 6,
    });
    pintarEquipos();
  });

  $('btnAgregarEscaner').addEventListener('click', function () {
    var lista = eq.borrador.escaneres;
    lista.push({
      id: idLibre('s', lista.concat(eq.borrador.balanzas)),
      nombre: 'Escáner ' + (lista.length + 1),
      simulador: true,
      puerto: '',
      numeroSerie: '',
      baudRate: 9600,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      autodeteccion: false,
    });
    pintarEquipos();
  });

  $('btnDescartar').addEventListener('click', function () {
    eq.borrador = copia(eq.guardado);
    pintarEquipos();
  });

  $('btnGuardarEquipos').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    api('/api/dispositivos', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(eq.borrador),
    })
      .then(function () {
        avisar('Guardado. Reconectando los equipos que cambiaron…', 'ok');
        return cargarEquipos();
      })
      .then(buscarPuertos)
      .catch(function (e) { avisar(e.message, 'error'); pintarBarraGuardar(); });
  });

  $('btnPuertos').addEventListener('click', function () {
    buscarPuertos().then(function () {
      avisar(eq.puertos.length + ' puerto(s) encontrado(s)', eq.puertos.length ? 'ok' : 'error');
    });
  });

  // Si se va de la pagina con cambios sin guardar, que el navegador pregunte.
  window.addEventListener('beforeunload', function (e) {
    if (sucio()) { e.preventDefault(); e.returnValue = ''; }
  });

  // --- diagnostico

  function pintarSelectDiagnostico() {
    var s = $('dgBalanza');
    var actual = s.value;
    s.innerHTML = '';
    eq.guardado.balanzas.forEach(function (b) {
      var o = document.createElement('option');
      o.value = b.id;
      o.textContent = b.nombre;
      s.appendChild(o);
    });
    if (actual && eq.guardado.balanzas.some(function (b) { return b.id === actual; })) s.value = actual;
    var v = eq.vivos.balanza[s.value];
    if (v) pintarDiagnostico(v);
  }

  $('dgBalanza').addEventListener('change', function () {
    var v = eq.vivos.balanza[this.value];
    if (v) pintarDiagnostico(v);
    $('dgTramas').textContent = 'Esperando tramas…';
    refrescarTramas();
  });

  function pintarDiagnostico(b) {
    $('dgPeso').textContent = kg(b.gramos || 0) + ' kg';
    $('dgEstado').textContent = !b.conectado
      ? (b.error || 'Desconectada')
      : (b.estable ? 'Estable' : 'Estabilizando');
    $('dgProto').textContent = b.simulador ? 'simulador' : (b.protocolo || '—');
  }

  function refrescarTramas() {
    if (document.querySelector('[data-panel="balanza"]').hidden) return;
    var id = $('dgBalanza').value;
    if (!id) { $('dgTramas').textContent = 'No hay balanzas guardadas.'; return; }
    api('/api/balanza/diagnostico?balanza=' + encodeURIComponent(id)).then(function (d) {
      $('dgTramas').textContent = d.tramas.length
        ? d.tramas.join('\n')
        : 'Todavía no llegó ninguna trama.' +
          (d.estado.simulador ? ' (la balanza está en modo simulador)' : '');
    }).catch(function () {});
  }

  function conectarWS() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    var ws = new WebSocket(proto + '://' + location.host + '/ws?todo=1');
    ws.onmessage = function (ev) {
      var m = JSON.parse(ev.data);
      if (m.tipo === 'balanza' && m.balanza) {
        eq.vivos.balanza[m.balanza] = m.estado;
        pintarVivo('balanza', m.balanza);
        if ($('dgBalanza').value === m.balanza) pintarDiagnostico(m.estado);
      } else if (m.tipo === 'escaner' && m.escaner && m.estado) {
        eq.vivos.escaner[m.escaner] = m.estado;
        pintarVivo('escaner', m.escaner);
      } else if (m.tipo === 'version' && m.version) {
        // Administracion no se recarga sola (puede haber un formulario a medio
        // llenar): avisa que hay una version nueva.
        if (!versionCargada) versionCargada = m.version;
        else if (m.version !== versionCargada) {
          $('avisoVersion').hidden = false;
          cargarVersion();
          setTimeout(cargarVersion, 15000); // el actualizador termina de verificar unos segundos despues
        }
      }
    };
    ws.onclose = function () { setTimeout(conectarWS, 2000); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }

  // ------------------------------------------------------------- ventas

  function pintarSheets(sh) {
    var panel = $('panelSheets');
    panel.hidden = !sh.habilitado;
    if (!sh.habilitado) return;
    $('shPendientes').textContent = sh.pendientes;
    $('shEnviadas').textContent = sh.enviadas;
    var txt = sh.ultimo_envio ? 'Última copia: ' + sh.ultimo_envio + '.' : 'Todavía no se copió ninguna venta.';
    if (sh.pendientes && sh.ultimo_error) {
      txt += ' Último error (venta #' + sh.ultimo_error.venta_id + '): ' + sh.ultimo_error.ultimo_error;
    }
    $('shDetalle').textContent = txt;
  }

  function cargarSheets() {
    api('/api/sheets/estado').then(function (d) { pintarSheets(d.sheets); })
      .catch(function () { $('panelSheets').hidden = true; });
  }

  $('btnSheetsReintentar').addEventListener('click', function () {
    var b = this;
    b.disabled = true;
    api('/api/sheets/reintentar', { method: 'POST' }).then(function (d) {
      pintarSheets(d.sheets);
      avisar(d.sheets.pendientes ? 'Siguen pendientes: ' + d.sheets.pendientes : 'Todo copiado a la planilla', d.sheets.pendientes ? 'error' : 'ok');
    }).catch(function (e) { avisar(e.message, 'error'); })
      .then(function () { b.disabled = false; });
  });

  // --- Totales por dia y por mes
  var mesElegido = null; // 'AAAA-MM'; null = el mes en curso
  var fmtMes = new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric' });
  var fmtSemana = new Intl.DateTimeFormat('es-AR', { weekday: 'short' });

  function nombreMes(mes) {
    var p = mes.split('-');
    var t = fmtMes.format(new Date(Number(p[0]), Number(p[1]) - 1, 1)); // 'septiembre de 2026'
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  function celdaTotal(centavos, maximo) {
    var ancho = maximo > 0 ? Math.max(2, Math.round((centavos / maximo) * 100)) : 0;
    return '<td class="der num celda-total">' + (centavos ? plata(centavos) : '—') +
      (centavos ? '<div class="barra" style="width:' + ancho + '%"></div>' : '') + '</td>';
  }

  function pintarTotales(d) {
    mesElegido = d.mes;
    var mesActual = d.hoy.slice(0, 7);

    // Selector: los meses con ventas, mas el actual y el elegido aunque no tengan.
    var lista = d.meses.map(function (m) { return m.mes; });
    [mesActual, d.mes].forEach(function (m) { if (lista.indexOf(m) < 0) lista.push(m); });
    lista.sort().reverse();
    var sel = $('tMes');
    sel.innerHTML = '';
    lista.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m;
      o.textContent = nombreMes(m) + (m === mesActual ? ' (en curso)' : '');
      sel.appendChild(o);
    });
    sel.value = d.mes;

    var tm = d.totalMes;
    $('tMesTotal').textContent = plata(tm.total_centavos);
    $('tMesVentas').textContent = tm.ventas;
    $('tMesPromedio').textContent = plata(tm.dias_con_ventas ? Math.round(tm.total_centavos / tm.dias_con_ventas) : 0);

    // Por dia: el mas reciente arriba; los dias sin ventas quedan en gris.
    var maxDia = d.dias.reduce(function (mx, x) { return Math.max(mx, x.total_centavos); }, 0);
    var tbD = $('tablaDias');
    tbD.innerHTML = '';
    if (!d.dias.length) {
      tbD.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--texto-tenue);padding:24px">Sin días para mostrar.</td></tr>';
    }
    d.dias.slice().reverse().forEach(function (x) {
      var p = x.dia.split('-');
      var fecha = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
      var tr = document.createElement('tr');
      if (!x.ventas) tr.className = 'cero';
      if (x.dia === d.hoy) tr.className += ' hoy';
      tr.innerHTML =
        '<td class="num"><span class="dia-sem">' + fmtSemana.format(fecha).replace('.', '').replace(/^./, function (c) { return c.toUpperCase(); }) + '</span>' +
          p[2] + '/' + p[1] + (x.dia === d.hoy ? ' · hoy' : '') + '</td>' +
        '<td class="der num">' + (x.ventas || '—') + '</td>' +
        celdaTotal(x.total_centavos, maxDia);
      tbD.appendChild(tr);
    });

    // Por mes: el mas reciente arriba; tocar uno muestra sus dias.
    var maxMes = d.meses.reduce(function (mx, x) { return Math.max(mx, x.total_centavos); }, 0);
    var tbM = $('tablaMeses');
    tbM.innerHTML = '';
    if (!d.meses.length) {
      tbM.innerHTML = '<tr><td colspan="3" style="text-align:center;color:var(--texto-tenue);padding:24px">Todavía no hay ventas.</td></tr>';
    }
    d.meses.forEach(function (x) {
      var tr = document.createElement('tr');
      tr.className = 'clic' + (x.mes === d.mes ? ' elegido' : '');
      tr.innerHTML =
        '<td><span class="mes-nombre">' + nombreMes(x.mes) + '</span></td>' +
        '<td class="der num">' + x.ventas + '</td>' +
        celdaTotal(x.total_centavos, maxMes);
      tr.title = x.dias_con_ventas + ' día' + (x.dias_con_ventas === 1 ? '' : 's') + ' con ventas';
      tr.addEventListener('click', function () { cargarTotales(x.mes); });
      tbM.appendChild(tr);
    });
  }

  function cargarTotales(mes) {
    var m = mes || mesElegido;
    api('/api/ventas/totales' + (m ? '?mes=' + encodeURIComponent(m) : ''))
      .then(pintarTotales)
      .catch(function (e) { avisar(e.message, 'error'); });
  }

  $('tMes').addEventListener('change', function () { cargarTotales(this.value); });

  function cargarVentas() {
    cargarSheets();
    cargarTotales();
    api('/api/ventas?limite=60').then(function (d) {
      $('vCantidad').textContent = d.resumen.ventas;
      $('vTotal').textContent = plata(d.resumen.total_centavos);

      // Con mas de una estacion, lo de hoy separado por estacion.
      var pe = (d.porEstacion || []);
      var cajaPe = $('vPorEstacion');
      cajaPe.hidden = pe.length < 2;
      cajaPe.innerHTML = '';
      pe.forEach(function (x) {
        var st = document.createElement('div');
        st.className = 'stat';
        st.innerHTML = '<div class="stat-label"></div><div class="stat-valor num" style="font-size:22px"></div>';
        st.firstChild.textContent = (x.estacion || 'Sin estación') + ' · ' + x.ventas + ' venta' + (x.ventas === 1 ? '' : 's');
        st.lastChild.textContent = plata(x.total_centavos);
        cajaPe.appendChild(st);
      });

      var tbody = $('tablaVentas');
      tbody.innerHTML = '';

      if (!d.ventas.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--texto-tenue);padding:28px">Todavía no hay ventas registradas.</td></tr>';
        return;
      }

      d.ventas.forEach(function (v) {
        var tr = document.createElement('tr');
        tr.style.cursor = 'pointer';
        tr.innerHTML =
          '<td class="num">' + v.id + '</td>' +
          '<td class="num">' + v.fecha + '</td>' +
          '<td></td>' +
          '<td class="der num">' + v.items_count + '</td>' +
          '<td class="der num">' + plata(v.total_centavos) + '</td>' +
          '<td class="der"><span class="pill">' + v.arca_estado + '</span></td>';
        tr.children[2].textContent = v.estacion || '—';
        tr.addEventListener('click', function () { verDetalle(v.id); });
        tbody.appendChild(tr);
      });
    }).catch(function (e) { avisar(e.message, 'error'); });
  }

  function verDetalle(id) {
    api('/api/ventas/' + id).then(function (d) {
      var v = d.venta;
      var caja = $('detalleVenta');
      caja.hidden = false;
      caja.textContent =
        'Venta #' + v.id + '   ' + v.fecha + (v.estacion ? '   ' + v.estacion : '') + '\n' +
        '-----------------------------------------------\n' +
        v.items.map(function (i) {
          var cant = i.tipo === 'peso'
            ? kg(i.cantidad) + ' kg x ' + plata(i.precio_centavos) + '/kg'
            : i.cantidad + ' x ' + plata(i.precio_centavos);
          return (i.nombre + (i.marca ? ' (' + i.marca + ')' : '')).padEnd(34).slice(0, 34) +
            cant.padStart(28) + plata(i.subtotal_centavos).padStart(14);
        }).join('\n') +
        '\n-----------------------------------------------\n' +
        'TOTAL'.padEnd(62) + plata(v.total_centavos).padStart(14);
      caja.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }).catch(function (e) { avisar(e.message, 'error'); });
  }

  // ------------------------------------------------------------- version

  var versionCargada = null;
  var TEXTO_DEPLOY = {
    'al-dia': '', desplegando: 'actualizando…', esperando: 'actualización esperando que se libere la caja',
    error: 'la última actualización falló (se volvió a la anterior)',
  };

  function cargarVersion() {
    api('/api/version').then(function (d) {
      var v = d.version || {};
      var txt = 'Versión ' + (v.corto || '?') + (v.fecha ? ' · ' + v.fecha : '');
      var dep = d.deploy;
      var extra = dep && TEXTO_DEPLOY[dep.estado];
      var nodo = $('adminVersion');
      nodo.textContent = txt + (extra ? ' · ' + extra : '');
      nodo.title = (v.mensaje || '') + (dep && dep.detalle ? '\n' + dep.detalle : '');
      nodo.classList.toggle('alerta', !!extra);
    }).catch(function () {});
  }

  // ------------------------------------------------------------- red

  function cargarRed() {
    api('/api/red').then(function (d) {
      var reales = (d.adaptadores || []).filter(function (a) { return !a.virtual; });
      var virtuales = (d.adaptadores || []).filter(function (a) { return a.virtual; });
      var txt = reales.length
        ? reales.map(function (a) { return a.url + '   (' + a.adaptador + ')'; }).join('\n')
        : 'Esta PC no tiene conexión de red. Solo funciona en http://localhost:' + d.puerto;
      if (virtuales.length) {
        txt += '\n\nNo usar (adaptadores virtuales):\n' +
          virtuales.map(function (a) { return a.url + '   (' + a.adaptador + ')'; }).join('\n');
      }
      $('direccionesRed').textContent = txt;
    }).catch(function () { $('direccionesRed').textContent = 'No se pudo leer la red.'; });
  }

  // ------------------------------------------------------------- arranque

  // Los grupos primero: el catalogo se ordena y se agrupa con esa lista.
  cargarGrupos().then(cargarProductos);
  cargarMarcas();
  cargarEquipos();
  cargarRed();
  cargarVersion();
  setInterval(cargarVersion, 60000);
  conectarWS();
  setInterval(refrescarTramas, 2000);
})();
