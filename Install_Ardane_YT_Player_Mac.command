#!/bin/bash
clear
echo "============================================================================"
echo "   ARDANE YT PLAYER - PRO SUITE (macOS INSTALLER)"
echo "   For Adobe Premiere Pro & Adobe After Effects"
echo "============================================================================"
echo ""

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/com.displayx.panel/CSXS/manifest.xml" ]; then
    PAYLOAD_DIR="$SCRIPT_DIR/com.displayx.panel"
elif [ -f "$SCRIPT_DIR/CSXS/manifest.xml" ]; then
    PAYLOAD_DIR="$SCRIPT_DIR"
else
    echo "[ERROR] Folder ekstensi tidak ditemukan."
    exit 1
fi

TARGET_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/com.displayx.panel"

echo "[1/3] Mengaktifkan izin Adobe CEP Extension (PlayerDebugMode)..."
for ver in 7 8 9 10 11 12 13 14; do
    defaults write com.adobe.CSXS.$ver PlayerDebugMode 1 2>/dev/null
done
echo "      - PlayerDebugMode aktif."
echo ""

echo "[2/3] Menyalin Ardane YT Player ke folder Adobe CEP..."
mkdir -p "$HOME/Library/Application Support/Adobe/CEP/extensions"
if [ -L "$TARGET_DIR" ] || [ -d "$TARGET_DIR" ]; then
    rm -rf "$TARGET_DIR"
fi
cp -R "$PAYLOAD_DIR" "$TARGET_DIR"
chmod -R 755 "$TARGET_DIR/bin" 2>/dev/null
echo "      - Terinstal di: $TARGET_DIR"
echo ""

echo "[3/3] Selesai!"
echo "============================================================================"
echo "   INSTALASI BERHASIL!"
echo "   Silakan Restart Premiere Pro / After Effects, lalu buka menu:"
echo "   Window > Extensions > Ardane YT Player"
echo "============================================================================"
read -p "Tekan [Enter] untuk menutup jendela ini..."
