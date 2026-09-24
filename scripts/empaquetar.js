'use strict';

/**
 * Arma el paquete para llevar el POS a otra PC con Windows.
 *
 *   npm run empaquetar        (o doble clic en empaquetar.bat)
 *
 * Deja en dist\ la carpeta BalanzaPOS y el archivo BalanzaPOS-AAAAMMDD-HHMM.zip con:
 *   - la aplicacion (src, public, scripts, config.json, package.json, README.md)
 *   - node_modules ya compilado para Windows 64 bits
 *   - runtime\node.exe: el MISMO Node con el que se compilo node_modules, asi la
 *     otra PC no necesita instalar Node ni tener internet
 *   - data\pos.db: copia consistente de la base (VACUUM INTO), aunque el POS este
 *     andando en este momento
 *   - instalar.bat / desinstalar.bat / detener.bat / servicio.bat
 *
 * No se copian: las tramas de captura, logs, los .gs de Apps Script ni
 * los archivos .env de ejemplo.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const DIST = path.join(RAIZ, 'dist');
const DESTINO = path.join(DIST, 'BalanzaPOS');

const COPIAR = ['src', 'public', 'scripts', 'node_modules', 'config.json', 'config.example.json', 'config.comun.json', 'package.json', 'package-lock.json', 'README.md'];
const INSTALADOR = path.join(RAIZ, 'instalador');

function sello() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function main() {
  if (process.platform === 'win32' && process.arch !== 'x64') {
    console.warn('  Aviso: este Node no es de 64 bits; el paquete va a quedar de 32 bits.');
  }

  console.log('\n  Armando paquete en', DESTINO);
  fs.rmSync(DESTINO, { recursive: true, force: true });
  fs.mkdirSync(path.join(DESTINO, 'data'), { recursive: true });
  fs.mkdirSync(path.join(DESTINO, 'runtime'), { recursive: true });

  for (const nombre of COPIAR) {
    const origen = path.join(RAIZ, nombre);
    if (!fs.existsSync(origen)) continue;
    fs.cpSync(origen, path.join(DESTINO, nombre), { recursive: true });
    console.log('   +', nombre);
  }

  for (const nombre of fs.readdirSync(INSTALADOR)) {
    fs.copyFileSync(path.join(INSTALADOR, nombre), path.join(DESTINO, nombre));
    console.log('   +', nombre);
  }

  // Node portable: el mismo ejecutable que esta corriendo este script.
  const nodeDestino = path.join(DESTINO, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(process.execPath, nodeDestino);
  console.log(`   + runtime (Node ${process.version} ${process.arch})`);

  // Base de datos: copia consistente aunque el POS este abierto.
  const origenDb = path.join(RAIZ, 'data', 'pos.db');
  if (fs.existsSync(origenDb)) {
    const Database = require('better-sqlite3');
    const db = new Database(origenDb, { readonly: true, fileMustExist: true });
    const destinoDb = path.join(DESTINO, 'data', 'pos.db');
    db.prepare('VACUUM INTO ?').run(destinoDb);
    const n = db.prepare('SELECT (SELECT COUNT(*) FROM productos) AS productos, (SELECT COUNT(*) FROM ventas) AS ventas').get();
    db.close();
    console.log(`   + data\\pos.db (${n.productos} productos, ${n.ventas} ventas)`);
  } else {
    console.log('   - data\\pos.db no existe: la otra PC arranca con la base vacía');
  }

  fs.writeFileSync(path.join(DESTINO, 'VERSION.txt'),
    `Paquete armado: ${new Date().toLocaleString('es-AR')}\r\n` +
    `Node: ${process.version} ${process.platform}-${process.arch}\r\n`, 'utf8');

  // Zip (Windows 10+ trae tar.exe, que arma .zip con -a).
  const zip = path.join(DIST, `BalanzaPOS-${sello()}.zip`);
  try {
    execFileSync('tar', ['-a', '-c', '-f', zip, '-C', DIST, 'BalanzaPOS'], { stdio: 'inherit' });
    const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
    console.log(`\n  Listo: ${zip} (${mb} MB)`);
  } catch (e) {
    console.log('\n  No se pudo comprimir (' + e.message + '). Copiá la carpeta dist\\BalanzaPOS tal cual.');
  }

  console.log('\n  En la otra PC: descomprimir en C:\\BalanzaPOS y ejecutar instalar.bat como administrador.\n');
}

main();
