@echo off
cd /d "%~dp0"
start "Task Watcher" /min node server.js
