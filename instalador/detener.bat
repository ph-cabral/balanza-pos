@echo off
REM Frena el POS (para copiar la base, actualizar, etc.). Vuelve solo al reiniciar la PC o con iniciar.bat.
REM Pide permisos de administrador.
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gestion.ps1" -Accion detener
pause
