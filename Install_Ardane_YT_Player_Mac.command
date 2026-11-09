#!/bin/bash
clear
echo "============================================================================"
echo "   ARDANE YT PLAYER - PRO SUITE (100% OFFLINE macOS INSTALLER)"
echo "   For Adobe Premiere Pro & Adobe After Effects"
echo "============================================================================"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/com.displayx.panel/CSXS/manifest.xml" ]; then
    PAYLOAD_DIR="$SCRIPT_DIR/com.displayx.panel"
elif [ -f "$SCRIPT_DIR/CSXS/manifest.xml" ]; then
    PAYLOAD_DIR="$SCRIPT_DIR"
else
    echo "[ERROR] Folder file ekstensi tidak ditemukan!"
    echo "Pastikan Anda sudah meng-extract file ZIP sebelum menjalankan installer."
    exit 1
fi

TARGET_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/com.displayx.panel"

echo "[1/3] Mengaktifkan izin Adobe CEP Extension (PlayerDebugMode)..."
for ver in 7 8 9 10 11 12 13 14; do
    defaults write com.adobe.CSXS.$ver PlayerDebugMode 1 2>/dev/null
    defaults write com.adobe.CSXS.$ver LogLevel 1 2>/dev/null
done
echo "      - Berhasil mengaktifkan mode ekstensi (CSXS 7-14)."
echo ""

echo "[2/3] Menyalin file plugin & mesin Offline (yt-dlp, FFmpeg, FFprobe)..."
mkdir -p "$HOME/Library/Application Support/Adobe/CEP/extensions"
if [ -L "$TARGET_DIR" ]; then
    rm -f "$TARGET_DIR"
elif [ -d "$TARGET_DIR" ]; then
    rm -rf "$TARGET_DIR"
fi

cp -R "$PAYLOAD_DIR" "$TARGET_DIR"
chmod -R 755 "$TARGET_DIR/bin" 2>/dev/null
xattr -cr "$TARGET_DIR" 2>/dev/null
echo "      - Lokasi terinstal: $TARGET_DIR"
echo ""

echo "[3/3] Memverifikasi komponen Offline Engine..."
if [ -x "$TARGET_DIR/bin/yt-dlp" ]; then
    echo "      - [OK] yt-dlp siap digunakan (Offline Universal Mach-O)"
else
    echo "      - [INFO] yt-dlp menggunakan sistem PATH"
fi
if [ -x "$TARGET_DIR/bin/ffmpeg" ]; then
    echo "      - [OK] ffmpeg siap digunakan (Offline Universal Mach-O)"
else
    echo "      - [INFO] ffmpeg menggunakan sistem PATH"
fi
if [ -x "$TARGET_DIR/bin/ffprobe" ]; then
    echo "      - [OK] ffprobe siap digunakan (Offline Universal Mach-O)"
else
    echo "      - [INFO] ffprobe menggunakan sistem PATH"
fi

echo ""
echo "============================================================================"
echo "   INSTALASI OFFLINE ARDANE YT PLAYER BERHASIL! (SELESAI DALAM ~2 DETIK)"
echo "============================================================================"
echo ""
echo "Cara Membuka Plugin:"
echo "1. Buka (atau Restart jika sedang terbuka) Adobe Premiere Pro atau After Effects."
echo "2. Klik menu di atas: Window > Extensions > Ardane YT Player"
echo ""
read -p "Tekan [Enter] untuk menutup jendela ini..."
