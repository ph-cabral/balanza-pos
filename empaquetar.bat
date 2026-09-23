@echo off
REM Arma dist\BalanzaPOS-AAAAMMDD-HHMM.zip para llevar el POS a otra PC.
REM Se puede correr con el POS andando: la base se copia de forma consistente.
cd /d "%~dp0"
node scripts\empaquetar.js
pause
