@echo off
REM Saca el arranque automatico, la regla de firewall y los accesos directos. NO borra la carpeta ni la base.
REM Pide permisos de administrador.
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gestion.ps1" -Accion desinstalar
pause
