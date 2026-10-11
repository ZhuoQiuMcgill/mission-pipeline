@echo off
rem `mp` on Windows for a harness that puts this directory on its PATH: runs the engine's launcher.
node "%~dp0..\..\bin\mp.mjs" %*
