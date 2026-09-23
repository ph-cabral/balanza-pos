# Despliegue automatico del POS. Lo corre la tarea programada
# "BalanzaPOS-Actualizar" cada 2 minutos (usuario SYSTEM).
#
#  1. Mira si la rama de produccion del repositorio tiene un commit nuevo.
#     (A produccion solo llegan los commits que pasaron las pruebas en GitHub.)
#  2. Espera a que la caja este libre: ningun carrito con articulos y nadie
#     usando el POS en el ultimo minuto. Si esta ocupada, reintenta en el
#     proximo ciclo.
#  3. Frena el POS, respalda la base, baja el codigo nuevo, instala
#     dependencias si cambiaron y vuelve a arrancar.
#  4. Si la version nueva no levanta, vuelve sola a la anterior (codigo,
#     dependencias y base) y no la reintenta hasta que llegue otro commit.
#
# A mano (como administrador):  actualizar-ahora.bat
#   -Forzar  despliega aunque la caja este en uso o el commit haya fallado antes.
#
# Log:     logs\deploy.log
# Estado:  logs\deploy-estado.json (lo muestra Administracion)
# Pausar:  en deploy.json poner "habilitado": false

param([switch]$Forzar)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'comun.ps1')

$Raiz    = Buscar-Raiz $PSScriptRoot
$Logs    = Join-Path $Raiz 'logs'
$Resp    = Join-Path $Raiz 'respaldos'
$RutaLog = Join-Path $Logs 'deploy.log'
$RutaEst = Join-Path $Logs 'deploy-estado.json'
New-Item -ItemType Directory -Force -Path $Logs, $Resp | Out-Null

function Log([string]$Texto) {
  if ((Test-Path $RutaLog) -and (Get-Item $RutaLog).Length -gt 2MB) {
    Move-Item $RutaLog (Join-Path $Logs 'deploy.old.log') -Force
  }
  $linea = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Texto
  Add-Content -Path $RutaLog -Value $linea -Encoding UTF8
  Write-Host $linea
}

$Estado = Leer-Json $RutaEst
if (-not $Estado) { $Estado = [pscustomobject]@{} }

function Guardar-Estado([string]$Nombre, [string]$Detalle, [hashtable]$Extra) {
  $o = [ordered]@{
    estado   = $Nombre
    detalle  = $Detalle
    fecha    = (Get-Date -Format 'dd/MM/yyyy HH:mm:ss')
    actual   = $script:Actual
    remoto   = $script:Remoto
    fallido  = $script:Fallido
  }
  if ($Extra) { foreach ($k in $Extra.Keys) { $o[$k] = $Extra[$k] } }
  Escribir-Json $RutaEst $o
}

# --- Un solo actualizador a la vez --------------------------------------------
$RutaLock = Join-Path $Logs 'deploy.lock'
try {
  $lock = [System.IO.File]::Open($RutaLock, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  Write-Host 'Ya hay una actualizacion en curso.'
  exit 0
}

try {
  $cfg = Leer-Json (Join-Path $Raiz 'deploy.json')
  if (-not $cfg) { throw 'Falta deploy.json (se crea con ci-instalar.bat).' }
  if ($cfg.habilitado -eq $false -and -not $Forzar) { exit 0 }
  $Rama   = if ($cfg.rama) { $cfg.rama } else { 'produccion' }
  $Espera = if ($cfg.esperaSegundos) { [int]$cfg.esperaSegundos } else { 60 }
  $Puerto = Leer-Puerto $Raiz
  Set-Location $Raiz
  $script:Fallido = $Estado.fallido

  # --- 1. Hay algo nuevo? ------------------------------------------------------
  $r = Git-POS $Raiz @('fetch', '--quiet', 'origin', "+refs/heads/${Rama}:refs/remotes/origin/$Rama")
  if ($r.Codigo -ne 0) {
    # Sin internet o GitHub caido: no es un error del POS, se reintenta solo.
    if ($Estado.estado -ne 'sin-conexion') { Log "No se pudo consultar el repositorio: $($r.Salida)" }
    $script:Actual = $Estado.actual; $script:Remoto = $Estado.remoto
    Guardar-Estado 'sin-conexion' $r.Salida
    exit 0
  }
  $script:Actual = (Git-POS $Raiz @('rev-parse', 'HEAD')).Salida.Trim()
  $script:Remoto = (Git-POS $Raiz @('rev-parse', "refs/remotes/origin/$Rama")).Salida.Trim()

  if ($Actual -eq $Remoto) {
    if ($Estado.estado -ne 'al-dia') { Guardar-Estado 'al-dia' '' }
    exit 0
  }

  $corto   = $Remoto.Substring(0, 7)
  $mensaje = (Git-POS $Raiz @('log', '-1', '--format=%s', $Remoto)).Salida

  if ($Remoto -eq $Fallido -and -not $Forzar) {
    exit 0   # ya fallo esta version; se espera el proximo commit
  }

  # --- 2. Caja libre? ----------------------------------------------------------
  if (-not $Forzar) {
    $ocupado = $null
    try {
      $ocupado = Invoke-RestMethod "http://localhost:$Puerto/api/deploy/ocupado?segundos=$Espera" -TimeoutSec 5 -UseBasicParsing
    } catch {
      # 404 = version vieja sin ese control: se despliega igual.
      # Sin respuesta = el POS esta caido: desplegar puede arreglarlo.
    }
    if ($ocupado -and $ocupado.ocupado) {
      $motivos = ($ocupado.motivos -join '; ')
      if ($Estado.estado -ne 'esperando' -or $Estado.remoto -ne $Remoto) {
        Log "Version $corto lista, esperando que se libere la caja: $motivos"
      }
      Guardar-Estado 'esperando' $motivos
      exit 0
    }
  }

  # --- 3. Desplegar ------------------------------------------------------------
  Log "Desplegando $corto ($mensaje) sobre $($Actual.Substring(0, 7))"
  Guardar-Estado 'desplegando' "$corto $mensaje"

  $node = Buscar-Node $Raiz
  if (-not $node) { throw 'No se encontro Node (runtime\node.exe).' }
  $npm  = Buscar-Npm $node
  $env:Path = (Split-Path $node) + ';' + $env:Path   # npm y prebuild-install usan este node

  $cambianDeps = (Git-POS $Raiz @('diff', '--quiet', $Actual, $Remoto, '--', 'package.json', 'package-lock.json')).Codigo -ne 0

  Detener-POS

  # Respaldo consistente de la base (VACUUM INTO aplica tambien el -wal).
  $db = Join-Path $Raiz 'data\pos.db'
  $respaldo = $null
  if (Test-Path $db) {
    $respaldo = Join-Path $Resp ("pos-{0}-antes-de-{1}.db" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $corto)
    $js = "const D=require('better-sqlite3');const d=new D(process.argv[1],{fileMustExist:true});d.prepare('VACUUM INTO ?').run(process.argv[2]);d.close()"
    $r = Ejecutar $node @('-e', $js, $db, $respaldo)
    if ($r.Codigo -ne 0 -or -not (Test-Path $respaldo)) {
      Iniciar-POS
      $script:Fallido = $Remoto   # no reintentar cada 2 minutos (cortaria la caja cada vez)
      throw "No se pudo respaldar la base; no se despliega. $($r.Salida)"
    }
    Log "Base respaldada en respaldos\$(Split-Path $respaldo -Leaf)"
    # Se guardan los ultimos 15 respaldos de despliegue.
    Get-ChildItem $Resp -Filter 'pos-*-antes-de-*.db' | Sort-Object LastWriteTime -Descending |
      Select-Object -Skip 15 | Remove-Item -Force -ErrorAction SilentlyContinue
  }

  $ok = $false
  $falla = ''
  $r = Git-POS $Raiz @('reset', '--hard', '--quiet', $Remoto)
  if ($r.Codigo -ne 0) { $falla = "git reset: $($r.Salida)" }

  if (-not $falla -and $cambianDeps) {
    Log 'Cambiaron las dependencias: npm ci'
    $r = Ejecutar $npm @('ci', '--omit=dev', '--no-audit', '--no-fund')
    if ($r.Codigo -ne 0) { $falla = "npm ci: $($r.Salida)" }
  }

  if (-not $falla) {
    Escribir-Version $Raiz
    Iniciar-POS
    if (Esperar-POS $Puerto 30 $Remoto) {
      # Que siga vivo unos segundos despues de arrancar (errores al abrir la balanza, etc.).
      Start-Sleep -Seconds 10
      if (Esperar-POS $Puerto 5 $Remoto) { $ok = $true } else { $falla = 'El POS arranco y se cayo enseguida.' }
    } else {
      $falla = 'El POS no respondio en 30 segundos con la version nueva.'
    }
  }

  if ($ok) {
    $script:Actual = $Remoto
    $script:Fallido = $null
    Log "OK: funcionando con $corto"
    Guardar-Estado 'al-dia' "$corto $mensaje"
    exit 0
  }

  # --- 4. Volver a la version anterior ----------------------------------------
  $cola = ''
  $posLog = Join-Path $Logs 'pos.log'
  if (Test-Path $posLog) { $cola = (Get-Content $posLog -Tail 15) -join "`n" }
  Log "FALLO $corto -> $falla`n$cola"
  Log "Volviendo a $($Actual.Substring(0, 7))"

  Detener-POS
  Git-POS $Raiz @('reset', '--hard', '--quiet', $Actual) | Out-Null
  if ($cambianDeps) { Ejecutar $npm @('ci', '--omit=dev', '--no-audit', '--no-fund') | Out-Null }
  if ($respaldo) {
    # Mientras la version nueva no respondia no se pudo vender: la base del
    # respaldo esta al dia.
    Remove-Item "$db-wal", "$db-shm" -Force -ErrorAction SilentlyContinue
    Copy-Item $respaldo $db -Force
  }
  Escribir-Version $Raiz
  Iniciar-POS
  $volvio = Esperar-POS $Puerto 60 $Actual
  Log ($(if ($volvio) { 'Version anterior funcionando.' } else { 'ATENCION: la version anterior tampoco responde. Mirar logs\pos.log' }))

  $script:Fallido = $Remoto
  Guardar-Estado 'error' "$corto no arranco: $falla"
  exit 1
}
catch {
  Log "Error: $($_.Exception.Message)"
  try { Guardar-Estado 'error' $_.Exception.Message } catch {}
  exit 1
}
finally {
  if ($lock) { $lock.Close() }
}
