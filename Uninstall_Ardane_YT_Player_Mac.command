#!/bin/bash
clear
echo "============================================================================"
echo "   ARDANE YT PLAYER - UNINSTALLER (macOS)"
echo "   For Adobe Premiere Pro & Adobe After Effects"
echo "============================================================================"
echo ""

TARGET_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions/com.displayx.panel"

if [ -L "$TARGET_DIR" ] || [ -d "$TARGET_DIR" ]; then
    echo "Ditemukan plugin Ardane YT Player terpasang di:"
    echo "  $TARGET_DIR"
    echo ""
    read -p "Apakah Anda yakin ingin menghapus / uninstall plugin ini? (y/n): " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
        echo ""
        echo "Menghapus plugin..."
        if [ -L "$TARGET_DIR" ]; then
            rm -f "$TARGET_DIR"
        else
            rm -rf "$TARGET_DIR"
        fi
        echo ""
        echo "============================================================================"
        echo "   [BERHASIL] Ardane YT Player telah dihapus dari Mac Anda."
        echo "   Silakan Restart Premiere Pro atau After Effects."
        echo "============================================================================"
    else
        echo ""
        echo "Proses uninstall dibatalkan."
    fi
else
    echo "[INFO] Plugin Ardane YT Player tidak ditemukan di:"
    echo "  $TARGET_DIR"
    echo "(Plugin belum terinstall atau sudah dihapus sebelumnya)."
fi

echo ""
read -p "Tekan [Enter] untuk menutup jendela ini..."
