@echo off
REM Lo ejecuta la tarea programada "BalanzaPOS" al prender la PC (no hace falta abrirlo a mano).
REM Mantiene el POS andando: si el proceso se cae, lo vuelve a levantar a los 5 segundos.
cd /d "%~dp0"
REM En la instalacion con git este archivo esta en instalador\ : la carpeta del POS es la de arriba.
if not exist "src\server.js" cd ..
if not exist logs mkdir logs

set "NODE=%CD%\runtime\node.exe"
if not exist "%NODE%" set "NODE=node"

:loop
REM Rotacion simple del log: pasados ~5 MB se guarda como pos.old.log
for %%A in (logs\pos.log) do if %%~zA GTR 5000000 move /y logs\pos.log logs\pos.old.log >nul
echo [%date% %time%] Iniciando POS>> logs\pos.log
"%NODE%" src\server.js >> logs\pos.log 2>&1
echo [%date% %time%] El POS se detuvo (codigo %errorlevel%). Reinicio en 5 segundos.>> logs\pos.log
REM ping en lugar de timeout: timeout falla cuando no hay consola (tarea de fondo)
ping -n 6 127.0.0.1 >nul
goto loop
