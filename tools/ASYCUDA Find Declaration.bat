@echo off
rem Double-click (or pin to the taskbar) to open ASYCUDAWorld at
rem Detailed Declaration > Find. ASYCUDAWorld must already be open and logged in.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0asycuda-open.ps1" -Action Find
