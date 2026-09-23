# Balanza Kretz Novel Eco 2 — conexión y protocolo

Documento de referencia del enlace serie entre el POS y la balanza.
Última verificación: 21/09/2026, sobre la PC `pc-013`.

## Equipo

Kretz Novel Eco 2. Máx. 30 kg, Mín. 0,1 kg, e = 5 g de 0 a 15 kg y 10 g de
15 a 30 kg.

Se conecta por un adaptador USB-serie FTDI (`VID_0403+PID_6001`, driver FTDI
2.12.36.20) que en esta PC aparece como **COM4**. El número de puerto puede
cambiar si se enchufa en otro conector USB: verificar con `npm run ports`.

## Cableado

El DB9 de la balanza usa solo tres pines:

| Pin | Señal | Dirección           |
|-----|-------|---------------------|
| 2   | Tx    | la balanza transmite |
| 3   | Rx    | la balanza recibe    |
| 5   | GND   | masa                 |

La balanza está cableada como **DCE**, así que el cable hacia la PC va
**derecho, sin cruzar**. No hay control de flujo por hardware.

## Parámetros de puerto

    9600 baudios
    8 bits de datos
    sin paridad
    2 bits de STOP

Los 2 bits de stop son los que especifica el manual de Kretz. En la práctica la
recepción también funciona con 1, pero se dejó en 2 para respetar la
especificación.

## Modo de transmisión

Se configura en la balanza, no en el software. Se entra al menú manteniendo una
tecla y pulsando otra; el código de acceso de fábrica es **99999**. Dentro de
COMUNICACIÓN → MODO hay cinco opciones:

| Opción   | Significado                                     |
|----------|-------------------------------------------------|
| `t_PESO` | transmisión continua de peso — **la que usamos** |
| `t_PPI`  | continua de peso, precio e importe               |
| `P_PESO` | a pedido, solo peso                              |
| `P_PPI`  | a pedido, peso, precio e importe                 |
| `dAtOS`  | modo datos                                       |

**La balanza debe quedar en `t_PESO`.** En ese modo transmite dos veces por
segundo sin que la PC le pida nada. En los modos "a pedido" responde a los
caracteres ASCII `P`, `p`, `W` o `w`, pero el driver del POS no está preparado
para eso: espera flujo continuo.

## Trama

    02 30 30 2e 32 33 35 0d
    STX  "0" "0" "." "2" "3" "5"  CR

Peso en kilogramos con tres decimales, enmarcado entre STX (0x02) y retorno de
carro. El ejemplo de arriba son 0,235 kg.

No incluye bandera de estabilidad ni distinción entre neto y bruto. La
estabilidad la deduce el driver: cuatro lecturas consecutivas dentro de 2 g de
tolerancia (`lecturasParaEstable` y `toleranciaEstabilidadKg` en `config.json`).

El parser correspondiente es `kretz`, en `src/scale/parsers.js`, y es el primero
de la lista de parsers.

## Diagnóstico

Si la balanza deja de leerse, en este orden:

    npm run ports      ¿existe el puerto COM? si no, es el adaptador o su driver
    npm run sondear    ¿llegan tramas? muestra los bytes crudos en hexadecimal
    npm run loopback   prueba el adaptador contra sí mismo

Para `loopback` hay que puentear pines en el DB9 del adaptador, con la balanza
desconectada: los pines **2 y 3** para la prueba de datos y los **7 y 8** para
la de líneas de control. Son pares de pines contiguos. Si las líneas de control
responden pero los datos no vuelven, el puente de 2-3 no está haciendo contacto:
es la causa más común de un falso negativo.

Importante: si el puente entre 2 y 3 queda puesto y se corre `npm run sondear`,
van a aparecer "respuestas" que en realidad son el eco de lo que mandó el
script. El script detecta ese caso y lo avisa, pero conviene tenerlo presente.

## Modo simulador

Con `"simulador": true` en `config.json`, el driver genera pesos sin tocar el
hardware y toda la aplicación funciona igual. Sirve para desarrollar sin la
balanza conectada.
