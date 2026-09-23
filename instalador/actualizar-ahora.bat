@echo off
REM Baja e instala YA la ultima version de la rama de produccion, aunque la caja
REM este en uso o esa version haya fallado antes. Ver logs\deploy.log.
REM Pide permisos de administrador.
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gestion.ps1" -Accion actualizar
pause
