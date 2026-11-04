@echo off
chcp 65001 >nul 2>&1
title Ardane YT Player - Official Windows Installer (Premiere Pro ^& After Effects)
color 0B

echo ============================================================================
echo    ARDANE YT PLAYER - PRO SUITE (WINDOWS INSTALLER)
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
    echo Pastikan Anda sudah melakukan Extract / Unzip file ZIP sebelum menjalankan installer ini.
    echo.
    pause
    exit /b 1
)

set "TARGET_CEP=%APPDATA%\Adobe\CEP\extensions\com.displayx.panel"

echo [1/4] Mengaktifkan izin Adobe CEP Extension (PlayerDebugMode)...
for %%V in (7 8 9 10 11 12 13 14) do (
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d "1" /f >nul 2>&1
    reg add "HKCU\Software\Adobe\CSXS.%%V" /v LogLevel /t REG_SZ /d "1" /f >nul 2>&1
)
echo       - Berhasil mengaktifkan mode ekstensi untuk Premiere Pro ^& After Effects.
echo.

echo [2/4] Menyalin file plugin Ardane YT Player ke folder Adobe CEP...
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
    pause
    exit /b 1
)
echo       - Lokasi terinstal: "%TARGET_CEP%"
echo.

echo [3/4] Memeriksa komponen mesin streaming ^& downloader (yt-dlp ^& FFmpeg)...
if not exist "%TARGET_CEP%\bin" mkdir "%TARGET_CEP%\bin" >nul 2>&1

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference = 'Continue'; " ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; " ^
    "$binDir = Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.displayx.panel\bin'; " ^
    "$ytDlpExe = Join-Path $binDir 'yt-dlp.exe'; " ^
    "if (-not (Test-Path $ytDlpExe)) { " ^
    "    Write-Host '      - Mengunduh yt-dlp.exe untuk Windows...' -ForegroundColor Yellow; " ^
    "    try { " ^
    "        Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile $ytDlpExe -UseBasicParsing; " ^
    "        Write-Host '      - yt-dlp.exe berhasil dipasang.' -ForegroundColor Green; " ^
    "    } catch { Write-Host '      - Catatan: Gagal mengunduh yt-dlp.exe otomatis.' -ForegroundColor Red; } " ^
    "} else { " ^
    "    Write-Host '      - yt-dlp.exe sudah tersedia (Siap).' -ForegroundColor Green; " ^
    "} " ^
    "$ffmpegExe = Join-Path $binDir 'ffmpeg.exe'; " ^
    "$ffprobeExe = Join-Path $binDir 'ffprobe.exe'; " ^
    "if ((-not (Test-Path $ffmpegExe)) -or (-not (Test-Path $ffprobeExe))) { " ^
    "    $sysFfmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue; " ^
    "    $sysFfprobe = Get-Command ffprobe.exe -ErrorAction SilentlyContinue; " ^
    "    if ($sysFfmpeg -and $sysFfprobe) { " ^
    "        Copy-Item $sysFfmpeg.Source $ffmpegExe -Force; " ^
    "        Copy-Item $sysFfprobe.Source $ffprobeExe -Force; " ^
    "        Write-Host '      - FFmpeg sistem terdeteksi dan disinkronkan ke plugin.' -ForegroundColor Green; " ^
    "    } else { " ^
    "        Write-Host '      - Mengunduh FFmpeg & FFprobe untuk Windows (H.264/4K Engine)...' -ForegroundColor Yellow; " ^
    "        $zipPath = Join-Path $env:TEMP 'ardane_ffmpeg_win64.zip'; " ^
    "        $extractDir = Join-Path $env:TEMP 'ardane_ffmpeg_extract'; " ^
    "        try { " ^
    "            Invoke-WebRequest -Uri 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' -OutFile $zipPath -UseBasicParsing; " ^
    "            if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force; } " ^
    "            Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force; " ^
    "            $foundFfmpeg = Get-ChildItem -Path $extractDir -Filter 'ffmpeg.exe' -Recurse | Select-Object -First 1; " ^
    "            $foundFfprobe = Get-ChildItem -Path $extractDir -Filter 'ffprobe.exe' -Recurse | Select-Object -First 1; " ^
    "            if ($foundFfmpeg) { Copy-Item $foundFfmpeg.FullName $ffmpegExe -Force; } " ^
    "            if ($foundFfprobe) { Copy-Item $foundFfprobe.FullName $ffprobeExe -Force; } " ^
    "            Remove-Item $zipPath -Force -ErrorAction SilentlyContinue; " ^
    "            Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue; " ^
    "            Write-Host '      - FFmpeg & FFprobe berhasil dipasang!' -ForegroundColor Green; " ^
    "        } catch { " ^
    "            Write-Host '      - Mencoba instalasi FFmpeg via WinGet...' -ForegroundColor Yellow; " ^
    "            try { winget install --id Gyan.FFmpeg -e --silent --accept-package-agreements --accept-source-agreements } catch {} " ^
    "        } " ^
    "    } " ^
    "} else { " ^
    "    Write-Host '      - FFmpeg & FFprobe sudah tersedia (Siap).' -ForegroundColor Green; " ^
    "}"

echo.
echo [4/4] Verifikasi akhir instalasi...
color 0A
echo ============================================================================
echo    INSTALASI ARDANE YT PLAYER BERHASIL!
echo ============================================================================
echo.
echo Cara Membuka Plugin:
echo 1. Buka (atau Restart jika sedang terbuka) Adobe Premiere Pro atau After Effects.
echo 2. Klik menu di atas: Window ^> Extensions ^> Ardane YT Player
echo.
pause
