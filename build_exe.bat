@echo off
cd /d "%~dp0"
echo [*] Installing build dependency...
python -m pip install -r requirements.txt -r requirements-build.txt
if errorlevel 1 goto error
echo [*] Building VHS-Security.exe...
python -m PyInstaller --clean --noconfirm VHS-Security.spec
if errorlevel 1 goto error
echo [OK] dist\VHS-Security.exe
exit /b 0
:error
echo [!] Build failed.
exit /b 1
