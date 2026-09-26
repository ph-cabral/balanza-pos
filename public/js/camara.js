/**
 * Lector de codigos de barras con la camara del equipo (celular o tablet).
 *
 * Abre la camara trasera a pantalla completa con un marco guia; cuando lee un
 * codigo (el mismo dos veces seguidas, para no tomar una lectura a medias)
 * vibra, cierra y se lo pasa a quien la abrio: el mismo camino que el lector
 * USB (buscar el producto y agregarlo al carrito).
 *
 * Deteccion:
 *  - BarcodeDetector del navegador si existe (Chrome en Android): rapido, sin
 *    descargar nada.
 *  - Si no (Brave, Windows, iPhone/iPad...), la version en WebAssembly de ZXing
 *    que se sirve desde el propio POS (public/vendor/barcode-detector), asi
 *    funciona sin internet. Se carga solo la primera vez que se usa.
 *
 * La camara exige pagina segura: https o localhost. Por http://IP:3000 el
 * navegador ni siquiera ofrece la camara; en ese caso se avisa y se ofrece
 * pasar a https://IP:3000 (mismo puerto, ver src/server.js).
 */
(function () {
  'use strict';

  var FORMATOS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'codabar', 'qr_code'];
  var VENDOR = '/vendor/barcode-detector/';
  var LECTURAS_IGUALES = 2;       // mismo codigo N veces seguidas para aceptarlo
  var MS_ENTRE_INTENTOS = 90;     // no hace falta analizar los 30 cuadros por segundo
  var MS_AYUDA = 9000;            // si no lee en este tiempo, mostramos consejos

  var detectorPromesa = null;     // se crea una sola vez
  var sesion = null;              // camara abierta ahora

  // ------------------------------------------------------------ disponibilidad

  function seguro() { return !!window.isSecureContext; }

  function tieneApi() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function pantallaTactil() {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  }

  /**
   * ¿Vale la pena mostrar el boton? Promesa de true/false.
   *  - Pagina segura: si el equipo tiene alguna camara.
   *  - Pagina no segura: en celulares/tablets si (el boton explica como pasar a
   *    https); en una PC con mouse no.
   */
  function hayCamara() {
    if (!seguro()) return Promise.resolve(pantallaTactil());
    if (!tieneApi()) return Promise.resolve(false);
    if (!navigator.mediaDevices.enumerateDevices) return Promise.resolve(true);
    return navigator.mediaDevices.enumerateDevices()
      .then(function (ds) { return ds.some(function (d) { return d.kind === 'videoinput'; }); })
      .catch(function () { return true; });
  }

  function urlSegura() {
    return 'https://' + location.host + location.pathname + location.search;
  }

  // ------------------------------------------------------------ detector

  function cargarScript(src) {
    return new Promise(function (ok, mal) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = ok;
      s.onerror = function () { mal(new Error('no se pudo cargar ' + src)); };
      document.head.appendChild(s);
    });
  }

  function detectorNativo() {
    if (!('BarcodeDetector' in window) || !window.BarcodeDetector.getSupportedFormats) {
      return Promise.resolve(null);
    }
    return window.BarcodeDetector.getSupportedFormats().then(function (soportados) {
      var formatos = FORMATOS.filter(function (f) { return soportados.indexOf(f) >= 0; });
      // Sin EAN-13 no sirve para una fiambreria: mejor el de respaldo.
      if (formatos.indexOf('ean_13') < 0) return null;
      return { tipo: 'nativo', det: new window.BarcodeDetector({ formats: formatos }) };
    }).catch(function () { return null; });
  }

  function detectorZxing() {
    var carga = window.BarcodeDetectionAPI ? Promise.resolve() : cargarScript(VENDOR + 'ponyfill.js');
    return carga.then(function () {
      var api = window.BarcodeDetectionAPI;
      // El .wasm desde el POS, no desde internet.
      return Promise.resolve(api.prepareZXingModule({
        overrides: {
          locateFile: function (ruta, prefijo) {
            return /\.wasm$/.test(ruta) ? VENDOR + ruta : prefijo + ruta;
          },
        },
        fireImmediately: true,
      })).then(function () {
        return { tipo: 'zxing', det: new api.BarcodeDetector({ formats: FORMATOS }) };
      });
    });
  }

  function obtenerDetector() {
    if (!detectorPromesa) {
      detectorPromesa = detectorNativo()
        .then(function (d) { return d || detectorZxing(); })
        .catch(function (e) { detectorPromesa = null; throw e; });
    }
    return detectorPromesa;
  }

  // ------------------------------------------------------------ pantalla

  var ICONO_CERRAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  var ICONO_LINTERNA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6c0 2-2 2-2 4v10a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V10c0-2-2-2-2-4V2h12z"/><path d="M6 6h12"/><path d="M12 12v2"/></svg>';

  function armarPantalla() {
    var raiz = document.createElement('div');
    raiz.className = 'camara';
    raiz.setAttribute('role', 'dialog');
    raiz.setAttribute('aria-label', 'Leer código de barras con la cámara');
    raiz.innerHTML =
      '<video class="camara-video" playsinline muted autoplay></video>' +
      '<div class="camara-velo"><div class="camara-marco"><i class="camara-laser"></i></div></div>' +
      '<div class="camara-arriba">' +
      '  <span class="camara-titulo">Escanear código</span>' +
      '  <button type="button" class="camara-btn camara-linterna" hidden aria-label="Linterna">' + ICONO_LINTERNA + '</button>' +
      '  <button type="button" class="camara-btn camara-cerrar" aria-label="Cerrar">' + ICONO_CERRAR + '</button>' +
      '</div>' +
      '<div class="camara-abajo">' +
      '  <div class="camara-estado">Abriendo la cámara…</div>' +
      '  <div class="camara-ayuda" hidden>Acercá o alejá un poco el celular, que el código quede derecho, ' +
      'dentro del marco y con buena luz.</div>' +
      '</div>';
    document.body.appendChild(raiz);
    return {
      raiz: raiz,
      video: raiz.querySelector('video'),
      marco: raiz.querySelector('.camara-marco'),
      estado: raiz.querySelector('.camara-estado'),
      ayuda: raiz.querySelector('.camara-ayuda'),
      cerrar: raiz.querySelector('.camara-cerrar'),
      linterna: raiz.querySelector('.camara-linterna'),
    };
  }

  function pitido() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = pitido.ctx || (pitido.ctx = new Ctx());
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = 1760;
      g.gain.setValueAtTime(0.08, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
      o.connect(g); g.connect(ctx.destination);
      o.start(); o.stop(ctx.currentTime + 0.13);
    } catch (e) { /* sin sonido no pasa nada */ }
  }

  // ------------------------------------------------------------ sesion

  function mensajeDeError(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      return 'No hay permiso para usar la cámara. Tocá el candado (o los ajustes del sitio) ' +
        'al lado de la dirección y permití la cámara.';
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'Este equipo no tiene cámara disponible.';
    if (n === 'NotReadableError' || n === 'AbortError') {
      return 'La cámara está en uso por otra aplicación. Cerrala y volvé a intentar.';
    }
    return 'No se pudo abrir la cámara' + (e && e.message ? ': ' + e.message : '.');
  }

  /**
   * Abre la camara. opciones:
   *   alLeer(codigo)           se leyo un codigo (la camara ya se cerro)
   *   alError(texto, accion)   no se pudo; accion opcional {texto, fn}
   */
  function abrir(opciones) {
    opciones = opciones || {};
    var alLeer = opciones.alLeer || function () {};
    var alError = opciones.alError || function (t) { window.alert(t); };

    if (sesion) return;

    if (!seguro()) {
      alError('Para usar la cámara hay que entrar por la dirección segura (https). ' +
        'La primera vez el navegador avisa que la conexión no es privada: ' +
        'tocá "Configuración avanzada" y "Continuar al sitio".', {
        texto: 'Ir a la versión segura',
        fn: function () { location.href = urlSegura(); },
      });
      return;
    }
    if (!tieneApi()) {
      alError('Este navegador no permite usar la cámara. Probá con Chrome.');
      return;
    }

    var ui = armarPantalla();
    var s = sesion = {
      ui: ui, stream: null, track: null, activo: true, timer: null, ayuda: null,
      ultimo: '', iguales: 0, linterna: false, canvas: document.createElement('canvas'),
      historial: false,
    };

    // El boton "atras" de Android cierra la camara en vez de salir del POS
    // (y perder la venta a medio cargar).
    try {
      history.pushState({ camaraPos: true }, '');
      s.historial = true;
    } catch (e) { /* sin historial: se cierra con la X */ }

    function alVolver() { cerrar(true); }
    function alOcultar() { if (document.hidden) cerrar(); }
    function alTecla(e) { if (e.key === 'Escape') cerrar(); }
    window.addEventListener('popstate', alVolver);
    document.addEventListener('visibilitychange', alOcultar);
    document.addEventListener('keydown', alTecla, true);

    function cerrar(porAtras) {
      if (!s.activo) return;
      s.activo = false;
      clearTimeout(s.timer);
      clearTimeout(s.ayuda);
      window.removeEventListener('popstate', alVolver);
      document.removeEventListener('visibilitychange', alOcultar);
      document.removeEventListener('keydown', alTecla, true);
      if (s.stream) s.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} });
      ui.video.srcObject = null;
      if (ui.raiz.parentNode) ui.raiz.parentNode.removeChild(ui.raiz);
      if (s.historial && !porAtras && history.state && history.state.camaraPos) {
        try { history.back(); } catch (e) {}
      }
      sesion = null;
    }
    s.cerrar = cerrar;

    ui.cerrar.addEventListener('click', function () { cerrar(); });

    ui.linterna.addEventListener('click', function () {
      if (!s.track) return;
      var prender = !s.linterna;
      s.track.applyConstraints({ advanced: [{ torch: prender }] })
        .then(function () {
          s.linterna = prender;
          ui.linterna.classList.toggle('prendida', prender);
        })
        .catch(function () { ui.linterna.hidden = true; });
    });

    var video = {
      facingMode: { ideal: 'environment' },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    };

    Promise.all([
      navigator.mediaDevices.getUserMedia({ video: video, audio: false }),
      // El detector se prepara mientras el usuario acepta el permiso.
      obtenerDetector().catch(function (e) { return { error: e }; }),
    ]).then(function (r) {
      var stream = r[0];
      var det = r[1];
      if (!s.activo) {
        stream.getTracks().forEach(function (t) { t.stop(); });
        return;
      }
      s.stream = stream;
      s.track = stream.getVideoTracks()[0];
      if (det.error) {
        cerrar();
        alError('No se pudo cargar el lector de códigos: ' + det.error.message);
        return;
      }
      s.det = det.det;
      s.tipo = det.tipo;

      prepararTrack(s);
      ui.video.srcObject = stream;
      return ui.video.play().catch(function () {}).then(function () {
        if (!s.activo) return;
        ui.estado.textContent = 'Apuntá al código de barras';
        s.ayuda = setTimeout(function () { ui.ayuda.hidden = false; }, MS_AYUDA);
        buscar(s, function (codigo) {
          ui.raiz.classList.add('leido');
          ui.estado.textContent = codigo;
          if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) {} }
          pitido();
          // Un instante con el marco en verde para que se vea que leyo.
          setTimeout(function () { cerrar(); alLeer(codigo); }, 250);
        });
      });
    }).catch(function (e) {
      cerrar();
      alError(mensajeDeError(e));
    });
  }

  function prepararTrack(s) {
    var t = s.track;
    var caps = {};
    try { caps = t.getCapabilities ? t.getCapabilities() : {}; } catch (e) {}
    if (caps.torch) s.ui.linterna.hidden = false;
    // Enfoque continuo donde se puede elegir (muchos Android arrancan en fijo).
    if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) {
      t.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(function () {});
    }
  }

  /**
   * Recorta la zona del marco (el centro de la imagen) y la analiza. Mirar solo
   * ahi evita tomar otro codigo que aparezca en el borde y es mas rapido.
   */
  function recorte(s) {
    var v = s.ui.video;
    var vw = v.videoWidth;
    var vh = v.videoHeight;
    if (!vw || !vh) return null;

    // Que parte del video se ve en pantalla (object-fit: cover recorta).
    var cw = v.clientWidth || vw;
    var ch = v.clientHeight || vh;
    var escala = Math.max(cw / vw, ch / vh);
    var visibleW = cw / escala;
    var visibleH = ch / escala;

    // El marco en coordenadas de la pantalla -> del video, con un margen.
    var r = s.ui.marco.getBoundingClientRect();
    var rv = v.getBoundingClientRect();
    var x0 = (vw - visibleW) / 2 + ((r.left - rv.left) / escala);
    var y0 = (vh - visibleH) / 2 + ((r.top - rv.top) / escala);
    var w = r.width / escala;
    var h = r.height / escala;
    var mx = w * 0.15;
    var my = h * 0.35;
    x0 = Math.max(0, x0 - mx); y0 = Math.max(0, y0 - my);
    w = Math.min(vw - x0, w + 2 * mx); h = Math.min(vh - y0, h + 2 * my);
    if (w < 16 || h < 16) { x0 = 0; y0 = 0; w = vw; h = vh; }

    // Hasta 1000 px de ancho alcanza para un EAN-13 y es mas liviano.
    var k = Math.min(1, 1000 / w);
    var c = s.canvas;
    c.width = Math.round(w * k);
    c.height = Math.round(h * k);
    var g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, x0, y0, w, h, 0, 0, c.width, c.height);
    return c;
  }

  function buscar(s, alEncontrar) {
    function ciclo() {
      if (!s.activo) return;
      var img = recorte(s);
      if (!img) { s.timer = setTimeout(ciclo, MS_ENTRE_INTENTOS); return; }
      s.det.detect(img).then(function (codigos) {
        if (!s.activo) return;
        var cod = elegir(codigos);
        if (cod && cod === s.ultimo) s.iguales++;
        else { s.ultimo = cod || ''; s.iguales = cod ? 1 : 0; }
        if (cod && s.iguales >= LECTURAS_IGUALES) return alEncontrar(cod);
        s.timer = setTimeout(ciclo, MS_ENTRE_INTENTOS);
      }).catch(function () {
        if (s.activo) s.timer = setTimeout(ciclo, MS_ENTRE_INTENTOS * 3);
      });
    }
    ciclo();
  }

  // Si hay varios codigos en el recorte, el mas grande (el que se esta apuntando).
  function elegir(codigos) {
    if (!codigos || !codigos.length) return '';
    var mejor = null;
    var area = -1;
    codigos.forEach(function (c) {
      var b = c.boundingBox || { width: 0, height: 0 };
      var a = b.width * b.height;
      if (a > area) { area = a; mejor = c; }
    });
    var v = String(mejor.rawValue || '').replace(/[\u0000-\u001f]/g, '').trim();
    return v.length >= 3 ? v : '';
  }

  window.Camara = {
    hayCamara: hayCamara,
    abrir: abrir,
    abierta: function () { return !!sesion; },
    cerrar: function () { if (sesion) sesion.cerrar(); },
    // Para pruebas y diagnostico: que detector se usa en este equipo.
    detector: function () { return obtenerDetector().then(function (d) { return d.tipo; }); },
  };
})();
