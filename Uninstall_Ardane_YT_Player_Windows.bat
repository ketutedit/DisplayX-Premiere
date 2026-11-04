@echo off
chcp 65001 >nul 2>&1
title Uninstall Ardane YT Player (Windows)
color 0E

echo ============================================================================
echo    UNINSTALL ARDANE YT PLAYER (WINDOWS)
echo ============================================================================
echo.

set "TARGET_CEP=%APPDATA%\Adobe\CEP\extensions\com.displayx.panel"

if exist "%TARGET_CEP%" (
    echo Menghapus folder plugin: "%TARGET_CEP%"...
    rmdir /s /q "%TARGET_CEP%"
    echo.
    color 0A
    echo [SELESAI] Ardane YT Player telah berhasil dihapus dari sistem Anda.
) else (
    echo [INFO] Ardane YT Player tidak ditemukan atau sudah dihapus sebelumnya.
)

echo.
pause
