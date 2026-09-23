/**
 * Lector de codigo de barras.
 *
 * Los escaneres USB se comportan como un teclado: "tipean" el codigo muy rapido
 * y terminan con Enter. No hace falta driver ni libreria: lo que hacemos es
 * distinguir esa rafaga de tecleo de una persona escribiendo.
 *
 * Criterio: 3 o mas caracteres, todos con menos de 60 ms entre si, cerrados con
 * Enter. Una persona no tipea tan rapido.
 */
(function () {
  'use strict';

  var MAX_MS_ENTRE_TECLAS = 60;
  var MIN_LARGO = 3;

  var buffer = '';
  var ultimaTecla = 0;
  var listeners = [];

  function reset() {
    buffer = '';
    ultimaTecla = 0;
  }

  document.addEventListener('keydown', function (e) {
    var ahora = Date.now();

    if (e.key === 'Enter') {
      var codigo = buffer.trim();
      reset();
      if (codigo.length >= MIN_LARGO) {
        e.preventDefault();
        listeners.forEach(function (fn) { fn(codigo); });
      }
      return;
    }

    // Solo caracteres imprimibles.
    if (e.key.length !== 1) return;

    // Demasiado lento para ser un escaner: empezamos de nuevo.
    if (ahora - ultimaTecla > MAX_MS_ENTRE_TECLAS) buffer = '';

    buffer += e.key;
    ultimaTecla = ahora;
  }, true);

  window.Scanner = {
    onScan: function (fn) { listeners.push(fn); },
  };
})();
