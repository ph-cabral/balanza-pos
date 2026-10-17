'use strict';

/**
 * Certificados para servir el POS tambien por HTTPS.
 *
 * Para que el celular pueda usar la camara (lector de codigos) el navegador
 * exige una pagina segura: HTTPS o localhost. En la red del local no hay dominio
 * ni certificado "de verdad", asi que cada PC se genera una CA propia (limitada a
 * redes privadas) y con ella firma el certificado del servidor. La CA se instala
 * una sola vez en cada celular/tablet (public/certificado.html, GET /ca.crt) y
 * desde ahi el navegador no avisa nada. Todo vive en data/tls/ (fuera de git).
 *
 * Sin dependencias: Node trae las claves (crypto) pero no arma certificados,
 * asi que el X.509 se codifica aca a mano (DER), con claves EC P-256.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- DER minimo

function largo(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  while (n > 0) { bytes.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, contenido) {
  return Buffer.concat([Buffer.from([tag]), largo(contenido.length), contenido]);
}

const seq = (...partes) => tlv(0x30, Buffer.concat(partes));
const set = (...partes) => tlv(0x31, Buffer.concat(partes));
const ctx = (n, contenido) => tlv(0xa0 + n, contenido);          // [n] EXPLICIT
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const octetos = (b) => tlv(0x04, b);
const bits = (b) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
const booleano = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0]));

function entero(buf) {
  // Positivo: si el primer bit esta prendido se antepone un 0.
  let b = buf;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oid(texto) {
  const n = texto.split('.').map(Number);
  const out = [40 * n[0] + n[1]];
  for (const v of n.slice(2)) {
    const grupo = [v & 0x7f];
    let x = v >> 7;
    while (x > 0) { grupo.unshift((x & 0x7f) | 0x80); x >>= 7; }
    out.push(...grupo);
  }
  return tlv(0x06, Buffer.from(out));
}

function fecha(d) {
  // UTCTime hasta 2049, GeneralizedTime despues (RFC 5280).
  const iso = d.toISOString().replace(/[-:T]/g, '').slice(0, 14); // AAAAMMDDhhmmss
  return d.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(iso.slice(2) + 'Z'))
    : tlv(0x18, Buffer.from(iso + 'Z'));
}

function nombre(cn) {
  return seq(
    set(seq(oid('2.5.4.10'), utf8('Balanza POS'))),   // O
    set(seq(oid('2.5.4.3'), utf8(cn))),                 // CN
  );
}

function ipABytes(ip) {
  return Buffer.from(ip.split('.').map(Number));
}

// ---------------------------------------------------------------- certificados

// Safari (iPad/iPhone) rechaza certificados de servidor de mas de 825 dias; 800
// dias y se renueva solo cuando falta un mes. La CA dura 10 años: se instala una
// sola vez en cada celular/tablet.
const DIAS_HOJA = 800;
const DIAS_CA = 3650;
const DIAS_RENOVAR = 30;
const DIAS_RENOVAR_CA = 60;

// La CA solo puede firmar certificados para estas redes privadas y estos nombres
// (nameConstraints): si alguien se llevara data/tls/ca.key no podria hacerse
// pasar por ningun sitio de internet en los equipos que confian en la CA.
const REDES_PRIVADAS = [
  [[10, 0, 0, 0], [255, 0, 0, 0]],
  [[127, 0, 0, 0], [255, 0, 0, 0]],
  [[172, 16, 0, 0], [255, 240, 0, 0]],
  [[192, 168, 0, 0], [255, 255, 0, 0]],
];

function ipPrivada(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const pem = (tipo, b) =>
  `-----BEGIN ${tipo}-----\n${b.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${tipo}-----\n`;

function extension(id, critica, valor) {
  return seq(oid(id), ...(critica ? [booleano(true)] : []), octetos(valor));
}

/** Identificador de clave (SHA-1 del punto publico EC, 65 bytes al final del SPKI). */
function idClave(publicKey) {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha1').update(spki.subarray(spki.length - 65)).digest();
}

/** Arma y firma un certificado X.509 v3. */
function construir({ cnSujeto, cnEmisor, publicKey, claveFirma, extensiones, dias }) {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const desde = new Date(Date.now() - 24 * 3600 * 1000); // un dia atras: relojes desfasados
  const hasta = new Date(desde.getTime() + dias * 24 * 3600 * 1000);
  const serie = crypto.randomBytes(16);
  serie[0] &= 0x7f;
  const tbs = seq(
    ctx(0, entero(Buffer.from([2]))),     // version v3
    entero(serie),
    ecdsaSha256,
    nombre(cnEmisor),
    seq(fecha(desde), fecha(hasta)),
    nombre(cnSujeto),
    spki,
    ctx(3, seq(...extensiones)),
  );
  const firma = crypto.sign('sha256', tbs, claveFirma); // ECDSA en DER
  return pem('CERTIFICATE', seq(tbs, ecdsaSha256, bits(firma)));
}

function claves() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, publicKey, pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}

const cnCA = (host) => `Balanza POS CA (${host})`;

/**
 * Crea la CA propia de esta PC. `nombres`: nombres DNS que podra firmar (ademas
 * de las redes privadas). Devuelve { key, cert } en PEM.
 */
function generarCA({ nombres = ['localhost'], host = os.hostname().toLowerCase(), dias = DIAS_CA } = {}) {
  const k = claves();
  const permitidos = Buffer.concat([
    ...nombres.map((n) => seq(tlv(0x82, Buffer.from(n, 'ascii')))),
    ...REDES_PRIVADAS.map(([ip, mascara]) => seq(tlv(0x87, Buffer.from([...ip, ...mascara])))),
  ]);
  const cert = construir({
    cnSujeto: cnCA(host), cnEmisor: cnCA(host), publicKey: k.publicKey, claveFirma: k.privateKey, dias,
    extensiones: [
      extension('2.5.29.19', true, seq(booleano(true), entero(Buffer.from([0])))),   // CA, sin subordinadas
      extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x01, 0x06]))),             // keyCertSign, cRLSign
      extension('2.5.29.14', false, octetos(idClave(k.publicKey))),
      extension('2.5.29.30', true, seq(tlv(0xa0, permitidos))),                       // nameConstraints
    ],
  });
  return { key: k.pem, cert };
}

/** Certificado de servidor para las IP y nombres dados, firmado por la CA { key, cert }. */
function emitir({ ca, ips = [], nombres = [], dias = DIAS_HOJA } = {}) {
  const k = claves();
  const caKey = crypto.createPrivateKey(ca.key);
  const caX = new crypto.X509Certificate(ca.cert);
  const cnEmisor = caX.subject.split('\n').find((l) => l.startsWith('CN=')).slice(3);
  const alt = [];
  for (const n of nombres) alt.push(tlv(0x82, Buffer.from(n, 'ascii')));   // dNSName
  for (const ip of ips) alt.push(tlv(0x87, ipABytes(ip)));                   // iPAddress
  const cert = construir({
    cnSujeto: nombres[0] || ips[0] || 'balanza-pos', cnEmisor, publicKey: k.publicKey, claveFirma: caKey, dias,
    extensiones: [
      extension('2.5.29.19', true, seq()),                                                  // no es CA
      extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))),                   // digitalSignature
      extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),                         // serverAuth
      extension('2.5.29.17', false, seq(...alt)),                                           // subjectAltName
      extension('2.5.29.14', false, octetos(idClave(k.publicKey))),
      extension('2.5.29.35', false, seq(tlv(0x80, idClave(caX.publicKey)))),               // authorityKeyIdentifier
    ],
  });
  return { key: k.pem, cert };
}

// ---------------------------------------------------------------- en disco

function ipsDeEstaPC() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if ((i.family === 'IPv4' || i.family === 4) && !i.address.startsWith('169.254.')) out.push(i.address);
    }
  }
  if (!out.includes('127.0.0.1')) out.push('127.0.0.1');
  return out;
}

const leer = (ruta) => fs.readFileSync(ruta);
const dias = (x) => (new Date(x.validTo).getTime() - Date.now()) / 86400000;

function leerCA(carpeta) {
  try {
    const key = leer(path.join(carpeta, 'ca.key'));
    const cert = leer(path.join(carpeta, 'ca.crt'));
    const meta = JSON.parse(leer(path.join(carpeta, 'ca.json')));
    if (dias(new crypto.X509Certificate(cert)) <= DIAS_RENOVAR_CA) return null;
    return { key, cert, nombres: meta.nombres || ['localhost'] };
  } catch (_) { return null; }
}

/**
 * Carga (o crea) los certificados de `carpeta` (data/tls/):
 *   ca.key / ca.crt / ca.json  CA propia de esta PC. ca.crt es lo que se instala en
 *                              celulares y tablets (una vez); ca.key no sale de la PC.
 *   pos.key / pos.crt          certificado del servidor, firmado por la CA.
 * El certificado del servidor se reemite solo cuando cambia la IP de la PC o falta
 * menos de un mes para que venza; la CA no cambia, asi que los equipos no tienen
 * que instalar nada de nuevo. Un certificado autofirmado de una version anterior
 * se reemplaza (los equipos tienen que instalar la CA).
 * Para empezar de cero: borrar data/tls/.
 * Devuelve { key, cert, ca, nuevo, nuevaCA }. `opc.ips` / `opc.host`: para pruebas.
 */
function cargarOCrear(carpeta, opc = {}) {
  const ips = (opc.ips || ipsDeEstaPC()).filter(ipPrivada);
  const host = (opc.host || os.hostname()).toLowerCase();
  fs.mkdirSync(carpeta, { recursive: true });

  let ca = leerCA(carpeta);
  const nuevaCA = !ca;
  if (nuevaCA) {
    const nombres = ['localhost'];
    if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) && host !== 'localhost') nombres.push(host);
    const g = generarCA({ nombres, host });
    fs.writeFileSync(path.join(carpeta, 'ca.key'), g.key, { mode: 0o600 });
    fs.writeFileSync(path.join(carpeta, 'ca.crt'), g.cert);
    fs.writeFileSync(path.join(carpeta, 'ca.json'), JSON.stringify({ nombres }));
    ca = { key: g.key, cert: g.cert, nombres };
  }
  const nombresHoja = ['localhost', host].filter((n, i, a) => ca.nombres.includes(n) && a.indexOf(n) === i);

  if (!nuevaCA) {
    try {
      const key = leer(path.join(carpeta, 'pos.key'));
      const cert = leer(path.join(carpeta, 'pos.crt'));
      const x = new crypto.X509Certificate(cert);
      const firmada = x.verify(new crypto.X509Certificate(ca.cert).publicKey);
      if (firmada && dias(x) > DIAS_RENOVAR &&
          ips.every((ip) => x.checkIP(ip)) && nombresHoja.every((n) => x.checkHost(n))) {
        return { key, cert, ca: ca.cert, nuevo: false, nuevaCA: false };
      }
    } catch (_) { /* no hay certificado todavia (o es de una version anterior) */ }
  }

  const h = emitir({ ca, ips, nombres: nombresHoja });
  fs.writeFileSync(path.join(carpeta, 'pos.key'), h.key, { mode: 0o600 });
  fs.writeFileSync(path.join(carpeta, 'pos.crt'), h.cert);
  return { key: h.key, cert: h.cert, ca: ca.cert, nuevo: true, nuevaCA };
}

module.exports = { generarCA, emitir, cargarOCrear, ipPrivada };
