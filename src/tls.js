'use strict';

/**
 * Certificado propio para servir el POS tambien por HTTPS.
 *
 * Para que el celular pueda usar la camara (lector de codigos) el navegador
 * exige una pagina segura: HTTPS o localhost. En la red del local no hay dominio
 * ni certificado "de verdad", asi que el POS se genera uno autofirmado la
 * primera vez que arranca y lo guarda en data/tls/ (propio de cada PC, fuera de
 * git). El navegador avisa una vez "La conexion no es privada"; se acepta y
 * queda.
 *
 * Sin dependencias: Node trae las claves (crypto) pero no arma certificados,
 * asi que el X.509 se codifica aca a mano (DER), con clave EC P-256.
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

// ---------------------------------------------------------------- certificado

// Safari (iPad/iPhone) rechaza certificados de mas de 825 dias aunque se
// acepte el aviso; 800 dias y se renueva solo cuando falta un mes.
const DIAS_VALIDEZ = 800;
const DIAS_RENOVAR = 30;

/**
 * Arma un certificado autofirmado para las IP y nombres dados.
 * Devuelve { key, cert } en PEM.
 */
function generar({ ips = [], nombres = [], dias = DIAS_VALIDEZ } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));

  const desde = new Date(Date.now() - 24 * 3600 * 1000); // un dia atras: relojes desfasados
  const hasta = new Date(desde.getTime() + dias * 24 * 3600 * 1000);

  const serie = crypto.randomBytes(16);
  serie[0] &= 0x7f;

  // subjectAltName: dNSName [2], iPAddress [7] (IMPLICIT, primitivos)
  const alt = [];
  for (const n of nombres) alt.push(tlv(0x82, Buffer.from(n, 'ascii')));
  for (const ip of ips) alt.push(tlv(0x87, ipABytes(ip)));

  const extensiones = ctx(3, seq(
    // basicConstraints: no es una CA
    seq(oid('2.5.29.19'), booleano(true), octetos(seq())),
    // keyUsage: digitalSignature (critica)
    seq(oid('2.5.29.15'), booleano(true), octetos(tlv(0x03, Buffer.from([0x07, 0x80])))),
    // extKeyUsage: serverAuth
    seq(oid('2.5.29.37'), octetos(seq(oid('1.3.6.1.5.5.7.3.1')))),
    // subjectAltName
    seq(oid('2.5.29.17'), octetos(seq(...alt))),
  ));

  const cn = nombres[0] || ips[0] || 'balanza-pos';
  const tbs = seq(
    ctx(0, entero(Buffer.from([2]))),     // version v3
    entero(serie),
    ecdsaSha256,
    nombre(cn),                           // emisor = sujeto (autofirmado)
    seq(fecha(desde), fecha(hasta)),
    nombre(cn),
    spki,
    extensiones,
  );

  const firma = crypto.sign('sha256', tbs, privateKey); // ECDSA en DER
  const der = seq(tbs, ecdsaSha256, bits(firma));

  const pem = (tipo, b) =>
    `-----BEGIN ${tipo}-----\n${b.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${tipo}-----\n`;

  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: pem('CERTIFICATE', der),
  };
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

/**
 * Lee el certificado de `carpeta` o lo genera si no existe. Una vez creado no
 * se regenera aunque cambie la IP de la PC: cada equipo acepto ESE certificado
 * y uno nuevo lo haria preguntar de nuevo; con un certificado autofirmado que
 * la IP no coincida da igual (el aviso se acepta de la misma forma).
 * Se renueva solo cuando esta por vencer. Para forzar uno nuevo: borrar
 * data/tls/. Devuelve { key, cert, nuevo }.
 */
function cargarOCrear(carpeta) {
  const rutaKey = path.join(carpeta, 'pos.key');
  const rutaCert = path.join(carpeta, 'pos.crt');
  try {
    const key = fs.readFileSync(rutaKey);
    const cert = fs.readFileSync(rutaCert);
    const vence = new Date(new crypto.X509Certificate(cert).validTo).getTime();
    if (vence - Date.now() > DIAS_RENOVAR * 24 * 3600 * 1000) return { key, cert, nuevo: false };
  } catch (_) { /* no hay certificado todavia (o esta roto) */ }

  const ips = ipsDeEstaPC();
  const host = os.hostname().toLowerCase();
  const { key, cert } = generar({ ips, nombres: ['localhost', host] });
  fs.mkdirSync(carpeta, { recursive: true });
  fs.writeFileSync(rutaKey, key, { mode: 0o600 });
  fs.writeFileSync(rutaCert, cert);
  return { key, cert, nuevo: true };
}

module.exports = { generar, cargarOCrear };
