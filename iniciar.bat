@echo off
REM Arranca el punto de venta. Dejar esta ventana abierta mientras se usa.
cd /d "%~dp0"

REM Si ya esta corriendo de fondo (instalado con instalar.bat), solo abrir la pantalla.
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul
if not errorlevel 1 (
  echo  El POS ya esta corriendo de fondo. Abriendo la pantalla...
  start "" http://localhost:3000
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  No se encontro Node.js en esta PC.
  echo  Instalalo desde https://nodejs.org (version LTS, 64 bits) y volve a intentar.
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo.
  echo  Primera vez: instalando dependencias, puede tardar unos minutos...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo  Fallo la instalacion. Revisa el mensaje de arriba.
    pause
    exit /b 1
  )
)

node src/server.js
pause
