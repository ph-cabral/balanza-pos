@echo off
REM Arranca el POS de fondo (si se habia detenido).
REM Pide permisos de administrador.
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gestion.ps1" -Accion iniciar
pause
