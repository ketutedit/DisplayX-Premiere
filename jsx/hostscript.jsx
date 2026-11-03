/**
 * hostscript.jsx
 * ExtendScript host script for Ardane YT Player (Premiere Pro & After Effects)
 */

// Helper to escape JSON strings safely in ExtendScript
function escapeJSONString(str) {
    if (!str) return '""';
    return '"' + String(str).replace(/\\/g, '\\\\')
                    .replace(/"/g, '\\"')
                    .replace(/\n/g, '\\n')
                    .replace(/\r/g, '\\r')
                    .replace(/\t/g, '\\t') + '"';
}

/**
 * Detect whether the current ExtendScript host is After Effects
 */
function isAfterEffectsHost() {
    try {
        if (typeof FolderItem !== "undefined") return true;
        if (app && app.project && typeof app.project.importFile === "function" && !app.project.rootItem) return true;
    } catch (e) {}
    return false;
}

/**
 * Returns project status and path for both Premiere Pro (PPRO) and After Effects (AEFT)
 */
function getProjectInfo() {
    try {
        if (!app || !app.project) {
            return '{"hasProject":false,"isSaved":false,"projectPath":"","projectName":"","hostApp":"UNKNOWN"}';
        }

        var proj = app.project;
        var isAE = isAfterEffectsHost();
        var hostApp = isAE ? "AEFT" : "PPRO";
        var pPath = "";
        var pName = "";

        if (isAE) {
            // In After Effects, app.project.file is a File object when saved, or null when unsaved
            if (proj.file) {
                pPath = proj.file.fsName ? String(proj.file.fsName) : (proj.file.fullName ? String(proj.file.fullName) : "");
                try {
                    pName = proj.file.name ? decodeURI(String(proj.file.name)) : "";
                } catch (de) {
                    pName = proj.file.name ? String(proj.file.name) : "";
                }
            }
        } else {
            // In Premiere Pro, app.project.path & app.project.name are strings
            pPath = proj.path ? String(proj.path) : "";
            pName = proj.name ? String(proj.name) : "";
            if (!pPath && proj.file && proj.file.fsName) {
                pPath = String(proj.file.fsName);
            }
        }

        var isSaved = (pPath !== null && pPath !== "" && pPath.length > 0);

        return '{"hasProject":true,"isSaved":' + (isSaved ? 'true' : 'false') +
               ',"hostApp":' + escapeJSONString(hostApp) +
               ',"projectPath":' + escapeJSONString(pPath) +
               ',"projectName":' + escapeJSONString(pName) + '}';
    } catch (err) {
        return '{"hasProject":false,"error":' + escapeJSONString(err.toString()) + '}';
    }
}

/**
 * Find or create a Bin (folder) inside Premiere Pro Project Panel
 */
function getOrCreateBin(binName) {
    if (!binName) binName = "YT Downloads";
    var root = app.project.rootItem;
    if (!root) return null;

    // Check if bin already exists at root
    for (var i = 0; i < root.children.numItems; i++) {
        var child = root.children[i];
        if (child && child.name === binName && (child.type === ProjectItemType.BIN || child.type === 2)) {
            return child;
        }
    }

    // Create new Bin if not found
    try {
        return root.createBin(binName);
    } catch (e) {
        return root;
    }
}

/**
 * Find or create a Folder inside After Effects Project Panel
 */
function getOrCreateAEFolder(folderName) {
    if (!folderName) folderName = "YT Downloads";
    var proj = app.project;
    if (!proj || !proj.items) return null;

    for (var i = 1; i <= proj.items.length; i++) {
        var item = proj.items[i];
        if (item && (item instanceof FolderItem) && item.name === folderName && item.parentFolder === proj.rootFolder) {
            return item;
        }
    }

    try {
        return proj.items.addFolder(folderName);
    } catch (e) {
        return null;
    }
}

/**
 * Import file directly into the designated Bin/Folder (Premiere Pro & After Effects)
 */
function importFileToBin(filePath, binName) {
    try {
        if (!app || !app.project) {
            return '{"success":false,"error":"Tidak ada project yang terbuka."}';
        }

        if (!filePath) {
            return '{"success":false,"error":"File path kosong."}';
        }

        // Clean path separators if on Mac/Windows
        var fileObj = new File(filePath);
        if (!fileObj.exists) {
            return '{"success":false,"error":"File fisik tidak ditemukan di: " + ' + escapeJSONString(filePath) + '}';
        }

        var targetBinName = binName || "YT Downloads";

        if (isAfterEffectsHost()) {
            // After Effects Import Pipeline
            var io = new ImportOptions(fileObj);
            try {
                io.sequence = false;
                if (typeof ImportAsType !== "undefined" && io.canImportAs && io.canImportAs(ImportAsType.FOOTAGE)) {
                    io.importAs = ImportAsType.FOOTAGE;
                }
            } catch (ioErr) {}

            var importedItem = app.project.importFile(io);
            var targetFolder = getOrCreateAEFolder(targetBinName);
            if (importedItem && targetFolder) {
                try {
                    importedItem.parentFolder = targetFolder;
                } catch (moveErr) {}
            }

            return '{"success":true,"hostApp":"AEFT","message":"File berhasil di-import ke folder After Effects","binName":' + escapeJSONString(targetBinName) + ',"filePath":' + escapeJSONString(fileObj.fsName) + '}';
        }

        // Premiere Pro Import Pipeline
        var targetBin = getOrCreateBin(targetBinName);
        var fileArray = [fileObj.fsName];
        
        // Count items in targetBin before import
        var beforeCount = targetBin && targetBin.children ? targetBin.children.numItems : 0;

        // app.project.importFiles(fileArray, suppressUI, targetBin, importAsNumberedStills)
        app.project.importFiles(fileArray, true, targetBin, false);

        // Fallback: If import went to root instead of targetBin, move it into targetBin
        if (targetBin && targetBin !== app.project.rootItem) {
            var afterCount = targetBin.children ? targetBin.children.numItems : 0;
            if (afterCount === beforeCount) {
                var root = app.project.rootItem;
                var fileNameOnly = fileObj.name;
                for (var j = root.children.numItems - 1; j >= 0; j--) {
                    var item = root.children[j];
                    if (item && item.name === fileNameOnly) {
                        item.moveProjectItem(targetBin);
                        break;
                    }
                }
            }
        }

        return '{"success":true,"hostApp":"PPRO","message":"File berhasil di-import ke bin Premiere Pro","binName":' + escapeJSONString(targetBinName) + ',"filePath":' + escapeJSONString(fileObj.fsName) + '}';
    } catch (err) {
        return '{"success":false,"error":' + escapeJSONString(err.toString()) + '}';
    }
}
