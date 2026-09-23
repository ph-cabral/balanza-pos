@echo off
REM Instala el POS en esta PC: queda corriendo solo cada vez que se prende la PC.
REM Pide permisos de administrador.
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gestion.ps1" -Accion instalar
pause
