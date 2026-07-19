@echo off
title Task Watcher — Setup
color 0A
echo.
echo  Installing dependencies...
cd /d "%~dp0"
call npm install
echo.
echo  Installing WhatsApp client (one-time ~170MB, please wait)...
call npm install whatsapp-web.js
echo.
echo  Launching Task Watcher...
echo.
node server.js
pause
