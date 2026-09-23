# Instalacion y control del POS como tarea de fondo en Windows.
# Se usa a traves de instalar.bat / detener.bat / iniciar.bat / desinstalar.bat.
# Con la instalacion por git (ci-instalar.bat) estos scripts quedan en
# instalador\ y la carpeta del POS es la de arriba; en el zip, en la raiz.
# OJO: ninguna variable local puede llamarse como un parametro ($Accion), ni
# siquiera con otras mayusculas: PowerShell no las distingue.
param([ValidateSet('instalar','detener','iniciar','desinstalar','actualizar')][string]$Accion = 'instalar')

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'comun.ps1')
$Dir     = Buscar-Raiz $PSScriptRoot
$Tarea   = $TareaPOS
$Regla   = 'Balanza POS'
$Escrit  = Join-Path $env:PUBLIC 'Desktop'

function Mostrar-Direcciones([int]$Puerto) {
  Write-Host ''
  Write-Host '  En esta PC:        ' -NoNewline; Write-Host "http://localhost:$Puerto" -ForegroundColor Cyan
  try {
    $r = Invoke-RestMethod "http://localhost:$Puerto/api/red" -TimeoutSec 3
    foreach ($d in $r.direcciones) { Write-Host '  Celular / tablet:  ' -NoNewline; Write-Host $d -ForegroundColor Cyan }
  } catch {}
  Write-Host "  Administracion:    http://localhost:$Puerto/admin.html"
  Write-Host ''
}

function Acceso-Directo([string]$Nombre, [string]$Url) {
  $edge = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  $sh = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $Escrit "$Nombre.lnk"))
  if ($edge) {
    # Modo aplicacion: ventana sin barra de direcciones, como un programa.
    $sh.TargetPath = $edge
    $sh.Arguments  = "--app=$Url"
    $sh.IconLocation = "$edge,0"
  } else {
    $sh.TargetPath = $Url
  }
  $sh.Save()
}

$Puerto = Leer-Puerto $Dir

switch ($Accion) {

  'instalar' {
    Write-Host "`n  Instalando Balanza POS en $Dir`n"

    # 1) Node: el que viene en el paquete (runtime\node.exe) o el instalado en la PC.
    $node = Buscar-Node $Dir
    if (-not $node) { throw 'No hay runtime\node.exe en el paquete ni Node instalado en la PC.' }
    Write-Host "  [1/6] Node: $(& $node --version)"

    # 2) Dependencias: probar que las nativas cargan con ESTE Node.
    Push-Location $Dir
    # Los programas externos escriben avisos por stderr: que no corten el script.
    $ErrorActionPreference = 'Continue'
    & $node -e "require('better-sqlite3'); require('serialport')" 2>$null
    if ($LASTEXITCODE -ne 0) {
      Write-Host '  [2/6] Las dependencias no cargan con este Node: reinstalando (necesita internet)...'
      $npm = Buscar-Npm $node
      if (-not $npm) { $npm = 'npm' }
      & $npm ci --omit=dev
      if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'Fallo npm ci.' }
    } else {
      Write-Host '  [2/6] Dependencias OK'
    }
    Pop-Location
    $ErrorActionPreference = 'Stop'

    # 3) Frenar una instancia previa, si la hubiera.
    Detener-POS
    Write-Host '  [3/6] Instancia anterior detenida (si habia)'

    # 4) Firewall: permitir entrar desde la red local (celular, tablet).
    Remove-NetFirewallRule -DisplayName $Regla -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $Regla -Direction Inbound -Protocol TCP -LocalPort $Puerto `
      -Action Allow -Profile Any -RemoteAddress LocalSubnet | Out-Null
    Write-Host "  [4/6] Firewall: puerto $Puerto abierto solo para la red local"

    # 5) Tarea programada: arranca al prender la PC, sin que nadie inicie sesion,
    #    y se reintenta si falla. servicio.bat ademas relanza node si se cae.
    $bat = Join-Path $PSScriptRoot 'servicio.bat'
    $tareaAccion  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$bat`"" -WorkingDirectory $Dir
    $disparo   = New-ScheduledTaskTrigger -AtStartup
    $usuario   = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $ajustes   = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                   -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
                   -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $Tarea -Action $tareaAccion -Trigger $disparo -Principal $usuario `
      -Settings $ajustes -Description 'Punto de venta con balanza (fiambreria)' -Force | Out-Null
    Start-ScheduledTask -TaskName $Tarea
    Write-Host '  [5/6] Tarea programada BalanzaPOS creada y en marcha'
    if (Test-Path (Join-Path $Dir 'deploy.json')) {
      Registrar-Actualizador $Dir
      Write-Host '        + BalanzaPOS-Actualizar: revisa el repositorio cada 2 minutos'
    }

    # 6) Que la PC no se duerma enchufada (si se suspende, el celular pierde el POS).
    powercfg /change standby-timeout-ac 0 | Out-Null
    powercfg /change hibernate-timeout-ac 0 | Out-Null
    Acceso-Directo 'Balanza POS' "http://localhost:$Puerto"
    Acceso-Directo 'Balanza POS - Administracion' "http://localhost:$Puerto/admin.html"
    Write-Host '  [6/6] Suspension desactivada con corriente; accesos directos en el escritorio'

    if (Esperar-POS $Puerto) {
      Write-Host "`n  El POS esta andando." -ForegroundColor Green
      Mostrar-Direcciones $Puerto
      Write-Host '  Revisar en Administracion > Balanza que el puerto COM sea el de esta PC.'
    } else {
      Write-Host "`n  La tarea arranco pero el POS no responde. Mirar logs\pos.log" -ForegroundColor Yellow
    }
  }

  'detener' {
    Detener-POS
    Write-Host "`n  POS detenido. Para volver a arrancarlo: iniciar.bat o reiniciar la PC.`n"
  }

  'iniciar' {
    Detener-POS
    Start-ScheduledTask -TaskName $Tarea
    if (Esperar-POS $Puerto) { Write-Host "`n  POS andando." -ForegroundColor Green; Mostrar-Direcciones $Puerto }
    else { Write-Host "`n  No responde. Mirar logs\pos.log" -ForegroundColor Yellow }
  }

  'desinstalar' {
    Detener-POS
    Unregister-ScheduledTask -TaskName $Tarea -Confirm:$false -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TareaActualizar -Confirm:$false -ErrorAction SilentlyContinue
    Remove-NetFirewallRule -DisplayName $Regla -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $Escrit 'Balanza POS.lnk'), (Join-Path $Escrit 'Balanza POS - Administracion.lnk') -ErrorAction SilentlyContinue
    Write-Host "`n  Desinstalado. La carpeta y la base de datos quedaron intactas.`n"
  }

  'actualizar' {
    # Despliegue manual: no espera a que se libere la caja ni saltea versiones que fallaron.
    & (Join-Path $PSScriptRoot 'actualizar.ps1') -Forzar
  }
}
