@echo off
rem Boot task entry point: runs the server and appends its output to logs\server.log.
cd /d "%~dp0\..\.."
if not exist logs mkdir logs
node server.js >> logs\server.log 2>&1
