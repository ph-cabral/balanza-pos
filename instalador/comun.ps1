# Funciones compartidas por gestion.ps1 (instalar/detener/iniciar) y
# actualizar.ps1 (despliegue automatico). Compatible con Windows PowerShell 5.1.
# Se carga con:  . (Join-Path $PSScriptRoot 'comun.ps1')

$TareaPOS         = 'BalanzaPOS'
$TareaActualizar  = 'BalanzaPOS-Actualizar'

# Carpeta raiz del POS. En el paquete zip los scripts estan en la raiz; en la
# instalacion con git estan en instalador\.
function Buscar-Raiz([string]$Desde) {
  if (Test-Path (Join-Path $Desde 'src\server.js')) { return $Desde }
  return (Split-Path $Desde -Parent)
}

function Leer-Json([string]$Ruta) {
  if (-not (Test-Path $Ruta)) { return $null }
  try { return (Get-Content $Ruta -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

# Escribe JSON en UTF-8 sin BOM (Node no acepta el BOM en JSON.parse).
function Escribir-Json([string]$Ruta, $Objeto) {
  $txt = $Objeto | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($Ruta, $txt, (New-Object System.Text.UTF8Encoding($false)))
}

function Leer-Puerto([string]$Raiz) {
  $c = Leer-Json (Join-Path $Raiz 'config.json')
  if ($c -and $c.http -and $c.http.port) { return [int]$c.http.port }
  return 3000
}

# Node: el de runtime\ (portable, trae npm) o el instalado en la PC.
function Buscar-Node([string]$Raiz) {
  $n = Join-Path $Raiz 'runtime\node.exe'
  if (Test-Path $n) { return $n }
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Buscar-Npm([string]$Node) {
  $npm = Join-Path (Split-Path $Node) 'npm.cmd'
  if (Test-Path $npm) { return $npm }
  $cmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}

function Buscar-Git {
  $cmd = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:ProgramFiles\Git\cmd\git.exe", "${env:ProgramFiles(x86)}\Git\cmd\git.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

# Corre un programa externo sin que sus avisos por stderr corten el script
# (en PowerShell 5.1 con ErrorActionPreference=Stop, cualquier linea en stderr
# es un error). Devuelve el codigo de salida y todo lo que escribio.
function Ejecutar([string]$Exe, [string[]]$Argumentos) {
  $eapPrevio = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $salida = & $Exe @Argumentos 2>&1 | ForEach-Object { "$_" }
    $codigo = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $eapPrevio
  }
  return [pscustomobject]@{ Codigo = $codigo; Salida = (($salida | Where-Object { $_ }) -join "`n") }
}

# git con la carpeta del POS. safe.directory=* evita el error "dubious
# ownership" cuando lo corre SYSTEM (la tarea programada) sobre una carpeta
# creada por un administrador.
function Git-POS([string]$Raiz, [string[]]$Argumentos) {
  $g = Buscar-Git
  if (-not $g) { throw 'No se encontro git en esta PC.' }
  return (Ejecutar $g (@('-c', 'safe.directory=*', '-C', $Raiz) + $Argumentos))
}

function Detener-POS {
  Stop-ScheduledTask -TaskName $TareaPOS -ErrorAction SilentlyContinue
  # Primero el bucle (servicio.bat) para que no relance node, despues node.
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object { $_.CommandLine -like '*servicio.bat*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*server.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

function Iniciar-POS {
  Start-ScheduledTask -TaskName $TareaPOS
}

# Espera a que el POS responda. Si se pasa $Commit, ademas tiene que ser esa
# version (asi no se confunde con un proceso viejo que quedo andando).
function Esperar-POS([int]$Puerto, [int]$Segundos = 30, [string]$Commit = '') {
  for ($i = 0; $i -lt $Segundos; $i++) {
    try {
      $r = Invoke-RestMethod "http://localhost:$Puerto/api/version" -TimeoutSec 2 -UseBasicParsing
      if (-not $Commit -or ($r.version -and $r.version.commit -eq $Commit)) { return $true }
    } catch {
      # Una version vieja sin /api/version: alcanza con que responda /api/red.
      if (-not $Commit) {
        try { Invoke-RestMethod "http://localhost:$Puerto/api/red" -TimeoutSec 2 -UseBasicParsing | Out-Null; return $true } catch {}
      }
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

# version.json: lo lee el servidor para mostrar la version y avisar a las
# pantallas que se recarguen.
function Escribir-Version([string]$Raiz) {
  $r = Git-POS $Raiz @('log', '-1', '--format=%H%n%h%n%cd%n%an%n%s', '--date=format-local:%d/%m/%Y %H:%M')
  if ($r.Codigo -ne 0) { return }
  $l = $r.Salida -split "`n"
  Escribir-Json (Join-Path $Raiz 'version.json') ([ordered]@{
    commit     = $l[0]
    corto      = $l[1]
    fecha      = $l[2]
    autor      = $l[3]
    mensaje    = ($l[4..($l.Count - 1)] -join ' ')
    desplegado = (Get-Date -Format 'dd/MM/yyyy HH:mm')
  })
}

# Tarea que revisa el repositorio cada 2 minutos y despliega si hay cambios.
function Registrar-Actualizador([string]$Raiz, [int]$Minutos = 2) {
  $ps1 = Join-Path $Raiz 'instalador\actualizar.ps1'
  $tareaAccion = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ps1`"" -WorkingDirectory $Raiz
  $disparo = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $Minutos)
  $usuario = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TareaActualizar -Action $tareaAccion -Trigger $disparo -Principal $usuario `
    -Settings $ajustes -Description 'Balanza POS: baja e instala las versiones nuevas del repositorio' -Force | Out-Null
}
