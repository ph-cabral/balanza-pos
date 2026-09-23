@echo off
REM Pasa esta PC a despliegue automatico desde GitHub (se corre una sola vez).
REM Uso:  ci-instalar.bat                      (pregunta el repositorio)
REM       ci-instalar.bat -Repo usuario/nombre
REM Pide permisos de administrador.
cd /d "%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  if "%~1"=="" (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  ) else (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  )
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ci-instalar.ps1" %*
pause
