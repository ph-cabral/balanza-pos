# Pasa la PC del POS a despliegue automatico desde GitHub. Se corre UNA vez,
# como administrador, con ci-instalar.bat. Es seguro volver a correrlo.
#
# Que hace:
#   1. Verifica git (lo instala con winget si falta).
#   2. Baja Node 22 portable (con npm) a runtime\.
#   3. Crea una clave de despliegue (solo lectura) y espera a que se cargue en
#      GitHub > Settings > Deploy keys.
#   4. Convierte la carpeta del POS en un clon del repositorio, sin tocar
#      data\ (la base), config.json ni logs\. Lo del paquete anterior queda
#      en _paquete_anterior\ por si hay que volver atras.
#   5. Instala dependencias, registra las tareas BalanzaPOS y
#      BalanzaPOS-Actualizar y arranca.
#
# OJO: ninguna variable local puede llamarse como un parametro (sin importar
# mayusculas): PowerShell las trata como la misma.

param(
  [string]$Repo = '',                     # usuario/repositorio en GitHub
  [string]$Carpeta = 'C:\BalanzaPOS',
  [string]$Rama = 'produccion',
  [int]$NodeMayor = 22
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Paso([string]$t) { Write-Host "`n  $t" -ForegroundColor Cyan }
function Nota([string]$t) { Write-Host "     $t" }

function Ejecutar([string]$Exe, [string[]]$Argumentos) {
  $eapPrevio = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $salida = & $Exe @Argumentos 2>&1 | ForEach-Object { "$_" }
    $codigo = $LASTEXITCODE
  } finally { $ErrorActionPreference = $eapPrevio }
  return [pscustomobject]@{ Codigo = $codigo; Salida = (($salida | Where-Object { $_ }) -join "`n") }
}

function Buscar-Git {
  $c = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @("$env:ProgramFiles\Git\cmd\git.exe", "${env:ProgramFiles(x86)}\Git\cmd\git.exe")) { if (Test-Path $p) { return $p } }
  return $null
}

function Detener-Todo {
  Stop-ScheduledTask -TaskName 'BalanzaPOS' -ErrorAction SilentlyContinue
  Stop-ScheduledTask -TaskName 'BalanzaPOS-Actualizar' -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like '*servicio.bat*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

Write-Host "`n  Balanza POS - despliegue automatico desde GitHub" -ForegroundColor Green
Write-Host   "  -------------------------------------------------"

if (-not $Repo) { $Repo = Read-Host '  Repositorio de GitHub (usuario/nombre, ej. everwear/balanza-pos)' }
$Repo = $Repo.Trim() -replace '^https://github.com/', '' -replace '\.git$', ''
if ($Repo -notmatch '^[\w.-]+/[\w.-]+$') { throw "Repositorio invalido: $Repo" }
New-Item -ItemType Directory -Force -Path $Carpeta | Out-Null
$Deploy = Join-Path $Carpeta '.deploy'
New-Item -ItemType Directory -Force -Path $Deploy | Out-Null

# --- 1. git ---------------------------------------------------------------------
Paso '[1/6] git'
$git = Buscar-Git
if (-not $git) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Nota 'Instalando Git for Windows con winget...'
    Ejecutar 'winget' @('install', '--id', 'Git.Git', '-e', '--silent', '--scope', 'machine',
      '--accept-package-agreements', '--accept-source-agreements') | Out-Null
    $git = Buscar-Git
  }
  if (-not $git) { throw 'Falta git. Instalar Git for Windows (https://git-scm.com/download/win) y volver a correr esto.' }
}
$gitBin = Split-Path (Split-Path $git -Parent) -Parent
$sshKeygen = Join-Path $gitBin 'usr\bin\ssh-keygen.exe'
Nota "$git ($((Ejecutar $git @('--version')).Salida))"

function G([string[]]$a) { return (Ejecutar $git (@('-c', 'safe.directory=*', '-C', $Carpeta) + $a)) }

# --- 2. Node portable -------------------------------------------------------------
Paso "[2/6] Node $NodeMayor portable"
$runtime = Join-Path $Carpeta 'runtime'
$nodeExe = Join-Path $runtime 'node.exe'
$npmCmd  = Join-Path $runtime 'npm.cmd'
$nodeNuevo = $null
$sirve = $false
if ((Test-Path $nodeExe) -and (Test-Path $npmCmd)) {
  $v = (Ejecutar $nodeExe @('--version')).Salida
  if ($v -match "^v$NodeMayor\.") { $sirve = $true; Nota "Ya esta: $v" }
}
if (-not $sirve) {
  $base = "https://nodejs.org/dist/latest-v$NodeMayor.x"
  $sumas = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
  $linea = ($sumas -split "`n") | Where-Object { $_ -match 'node-v[\d.]+-win-x64\.zip$' } | Select-Object -First 1
  if (-not $linea) { throw 'No se encontro el zip de Node para Windows en nodejs.org.' }
  $hash, $zipNombre = ($linea.Trim() -split '\s+')
  $zip = Join-Path $Deploy $zipNombre
  Nota "Bajando $zipNombre..."
  Invoke-WebRequest "$base/$zipNombre" -OutFile $zip -UseBasicParsing
  if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $hash.ToUpper()) { throw 'El zip de Node vino corrupto (hash distinto).' }
  $tmp = Join-Path $Deploy 'node-tmp'
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  Expand-Archive $zip -DestinationPath $tmp
  $nodeNuevo = (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName
  Remove-Item $zip -Force
  Nota "Listo ($zipNombre); se instala en runtime\ al cambiar de version."
}

# --- 3. Clave de despliegue ---------------------------------------------------------
Paso '[3/6] Clave de despliegue (solo lectura)'
$clave = Join-Path $Deploy 'id_ed25519'
if (-not (Test-Path $clave)) {
  # cmd /c para pasar la frase vacia (-N "") tal cual: PowerShell 5.1 descarta los argumentos vacios.
  cmd /c "`"$sshKeygen`" -q -t ed25519 -N `"`" -C `"BalanzaPOS@$env:COMPUTERNAME`" -f `"$clave`""
  if (-not (Test-Path $clave)) { throw 'No se pudo crear la clave con ssh-keygen.' }
}
# Solo SYSTEM y Administradores pueden leer la carpeta de la clave.
icacls $Deploy /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null

$sshCmd = "ssh -i '$($clave -replace '\\','/')' -o UserKnownHostsFile='$((Join-Path $Deploy 'known_hosts') -replace '\\','/')' -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
# Puerto 443 (ssh.github.com): pasa aunque la red bloquee el 22.
$url = "ssh://git@ssh.github.com:443/$Repo.git"

$probar = { Ejecutar $git @('-c', "core.sshCommand=$sshCmd", 'ls-remote', '--heads', $url, $Rama) }
$r = & $probar
while ($r.Codigo -ne 0 -or -not $r.Salida -or $r.Salida -notmatch "refs/heads/$Rama") {
  $pub = (Get-Content "$clave.pub" -Raw).Trim()
  try { Set-Clipboard -Value $pub } catch {}
  Write-Host ''
  Write-Host '  Falta autorizar esta PC en GitHub (o la rama todavia no existe):' -ForegroundColor Yellow
  Write-Host "   1. Entrar a https://github.com/$Repo/settings/keys  ->  Add deploy key"
  Write-Host "   2. Title: BalanzaPOS $env:COMPUTERNAME   Key: (ya esta copiada, pegar con Ctrl+V)"
  Write-Host '   3. NO tildar "Allow write access"  ->  Add key'
  Write-Host ''
  Write-Host "  $pub" -ForegroundColor Gray
  if ($r.Salida -and $r.Codigo -eq 0) { Write-Host "`n  (La conexion anda pero no existe la rama '$Rama': falta que corra la primera prueba en GitHub Actions.)" -ForegroundColor Yellow }
  elseif ($r.Salida) { Write-Host "`n  Respuesta: $($r.Salida)" -ForegroundColor DarkGray }
  $respuesta = Read-Host "`n  Enter para volver a probar, S para salir"
  if ($respuesta -match '^[sS]') { exit 1 }
  $r = & $probar
}
Nota "Conexion con $Repo OK"

# --- 4. Carpeta -> clon del repositorio ------------------------------------------------
Paso "[4/6] Carpeta $Carpeta"
$esClon = Test-Path (Join-Path $Carpeta '.git')
if (-not $esClon) {
  G @('init', '--quiet') | Out-Null
  G @('remote', 'add', 'origin', $url) | Out-Null
}
G @('remote', 'set-url', 'origin', $url) | Out-Null
G @('config', 'core.sshCommand', $sshCmd) | Out-Null
G @('config', 'core.autocrlf', 'true') | Out-Null
$r = G @('fetch', '--quiet', 'origin', "+refs/heads/${Rama}:refs/remotes/origin/$Rama")
if ($r.Codigo -ne 0) { throw "git fetch: $($r.Salida)" }
Nota 'Codigo descargado'

Detener-Todo
Nota 'POS detenido'

# Respaldo de la base antes de tocar nada.
$db = Join-Path $Carpeta 'data\pos.db'
if (Test-Path $db) {
  $dirResp = Join-Path $Carpeta 'respaldos'
  New-Item -ItemType Directory -Force -Path $dirResp | Out-Null
  $sello = Get-Date -Format 'yyyyMMdd-HHmmss'
  foreach ($f in @('pos.db', 'pos.db-wal', 'pos.db-shm')) {
    $o = Join-Path $Carpeta "data\$f"
    if (Test-Path $o) { Copy-Item $o (Join-Path $dirResp "ci-instalar-$sello-$f") }
  }
  Nota "Base respaldada en respaldos\ci-instalar-$sello-pos.db"
}

if (-not $esClon) {
  # Lo del paquete zip anterior se aparta (no se borra) para no mezclarlo con el repositorio.
  $quedan = @('data', 'config.json', 'logs', 'respaldos', '.deploy', '.git', 'deploy.json', '_paquete_anterior')
  if (-not $nodeNuevo) { $quedan += 'runtime' }
  $aparte = Join-Path $Carpeta ("_paquete_anterior\" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  $mover = Get-ChildItem $Carpeta -Force | Where-Object { $quedan -notcontains $_.Name }
  if ($mover) {
    New-Item -ItemType Directory -Force -Path $aparte | Out-Null
    $mover | ForEach-Object { Move-Item $_.FullName (Join-Path $aparte $_.Name) }
    Nota "Paquete anterior apartado en $aparte"
  }
}
if ($nodeNuevo) {
  if (Test-Path $runtime) {
    $viejo = Join-Path $Carpeta ("_paquete_anterior\runtime-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Force -Path (Split-Path $viejo) | Out-Null
    Move-Item $runtime $viejo
  }
  Move-Item $nodeNuevo $runtime
  Remove-Item (Join-Path $Deploy 'node-tmp') -Recurse -Force -ErrorAction SilentlyContinue
  Nota "runtime\ = Node $((Ejecutar $nodeExe @('--version')).Salida)"
}

$r = G @('checkout', '--force', '-B', $Rama, "refs/remotes/origin/$Rama")
if ($r.Codigo -ne 0) { throw "git checkout: $($r.Salida)" }
Nota "Version: $((G @('log', '-1', '--format=%h %s')).Salida)"

# --- 5. Dependencias y configuracion ------------------------------------------------------
Paso '[5/6] Dependencias'
$env:Path = "$runtime;$env:Path"
Push-Location $Carpeta
$r = Ejecutar $npmCmd @('ci', '--omit=dev', '--no-audit', '--no-fund')
Pop-Location
if ($r.Codigo -ne 0) { throw "npm ci fallo:`n$($r.Salida)" }
$r = Ejecutar $nodeExe @('-e', "require('$($Carpeta -replace '\\','/')/node_modules/better-sqlite3'); require('$($Carpeta -replace '\\','/')/node_modules/serialport')")
if ($r.Codigo -ne 0) { throw "Las dependencias no cargan:`n$($r.Salida)" }
Nota 'npm ci OK (better-sqlite3 y serialport cargan)'

. (Join-Path $Carpeta 'instalador\comun.ps1')
$cfgDeploy = Leer-Json (Join-Path $Carpeta 'deploy.json')
if (-not $cfgDeploy) {
  Escribir-Json (Join-Path $Carpeta 'deploy.json') ([ordered]@{
    habilitado = $true; repo = $Repo; rama = $Rama; esperaSegundos = 60
  })
  Nota 'deploy.json creado'
}
Escribir-Version $Carpeta
if (-not (Test-Path (Join-Path $Carpeta 'config.json'))) {
  Copy-Item (Join-Path $Carpeta 'config.example.json') (Join-Path $Carpeta 'config.json')
  Nota 'config.json nuevo desde config.example.json (revisar balanza y Sheets en Administracion)'
}

# --- 6. Tareas y arranque ----------------------------------------------------------------
Paso '[6/6] Tareas programadas y arranque'
& (Join-Path $Carpeta 'instalador\gestion.ps1') -Accion instalar

Write-Host "`n  Listo. Cada push a main que pase las pruebas llega a esta PC en unos minutos." -ForegroundColor Green
Write-Host   "  Log de despliegues: $Carpeta\logs\deploy.log`n"
