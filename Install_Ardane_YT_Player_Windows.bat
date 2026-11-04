@echo off
chcp 65001 >nul 2>&1
title Ardane YT Player - Offline Windows Installer (Premiere Pro ^& After Effects)
color 0B

echo ============================================================================
echo    ARDANE YT PLAYER - PRO SUITE (100%% OFFLINE WINDOWS INSTALLER)
echo    For Adobe Premiere Pro ^& Adobe After Effects
echo ============================================================================
echo.

set "SRC_DIR=%~dp0"
if "%SRC_DIR:~-1%"=="\" set "SRC_DIR=%SRC_DIR:~0,-1%"

if exist "%SRC_DIR%\com.displayx.panel\CSXS\manifest.xml" (
    set "PAYLOAD_DIR=%SRC_DIR%\com.displayx.panel"
) else if exist "%SRC_DIR%\CSXS\manifest.xml" (
    set "PAYLOAD_DIR=%SRC_DIR%"
) else (
    color 0C
    echo [ERROR] Folder file ekstensi tidak ditemukan!
    echo Pastikan Anda sudah melakukan Extract / Unzip file ZIP terlebih dahulu
    echo sebelum menjalankan Install_Ardane_YT_Player_Windows.bat.
    echo.
    pause
    exit /b 1
)

set "TARGET_CEP=%APPDATA%\Adobe\CEP\extensions\com.displayx.panel"

echo [1/3] Mengaktifkan izin Adobe CEP Extension (PlayerDebugMode)...
for %%V in (7 8 9 10 11 12 13 14) do (
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v LogLevel /t REG_SZ /d "1" /f >nul 2>&1
)
echo       - Berhasil mengaktifkan mode ekstensi untuk Premiere Pro ^& After Effects.
echo.

echo [2/3] Menyalin file plugin ^& mesin Offline (yt-dlp + FFmpeg + FFprobe)...
if not exist "%APPDATA%\Adobe\CEP\extensions" (
    mkdir "%APPDATA%\Adobe\CEP\extensions" >nul 2>&1
)
if exist "%TARGET_CEP%" (
    rmdir /s /q "%TARGET_CEP%" >nul 2>&1
)
mkdir "%TARGET_CEP%" >nul 2>&1

xcopy "%PAYLOAD_DIR%\*" "%TARGET_CEP%\" /E /I /H /Y /Q >nul
if errorlevel 1 (
    color 0C
    echo [ERROR] Gagal menyalin file plugin ke "%TARGET_CEP%".
    echo Pastikan Premiere Pro / After Effects sedang ditutup lalu coba lagi.
    pause
    exit /b 1
)
echo       - Lokasi terinstal: "%TARGET_CEP%"
echo.

echo [3/3] Memverifikasi komponen Offline Engine...
if exist "%TARGET_CEP%\bin\yt-dlp.exe" (
    echo       - [OK] yt-dlp.exe siap digunakan ^(Offline Bundled^)
) else (
    echo       - [INFO] yt-dlp.exe menggunakan sistem PATH
)
if exist "%TARGET_CEP%\bin\ffmpeg.exe" (
    echo       - [OK] ffmpeg.exe siap digunakan ^(Offline Bundled^)
) else (
    echo       - [INFO] ffmpeg.exe menggunakan sistem PATH
)
if exist "%TARGET_CEP%\bin\ffprobe.exe" (
    echo       - [OK] ffprobe.exe siap digunakan ^(Offline Bundled^)
) else (
    echo       - [INFO] ffprobe.exe menggunakan sistem PATH
)

echo.
color 0A
echo ============================================================================
echo    INSTALASI OFFLINE ARDANE YT PLAYER BERHASIL! (SELESAI DALAM HITUNGAN DETIK)
echo ============================================================================
echo.
echo Cara Membuka Plugin:
echo 1. Buka (atau Restart jika sedang terbuka) Adobe Premiere Pro atau After Effects.
echo 2. Klik menu di atas: Window ^> Extensions ^> Ardane YT Player
echo.
pause
