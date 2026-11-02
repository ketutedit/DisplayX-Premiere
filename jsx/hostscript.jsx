/**
 * hostscript.jsx
 * ExtendScript host script for Ardane YT Player (Player + Multi-Downloader & Bin Importer)
 */

// Helper to escape JSON strings safely in ExtendScript
function escapeJSONString(str) {
    if (!str) return '""';
    return '"' + str.replace(/\\/g, '\\\\')
                    .replace(/"/g, '\\"')
                    .replace(/\n/g, '\\n')
                    .replace(/\r/g, '\\r')
                    .replace(/\t/g, '\\t') + '"';
}

/**
 * Returns project status and path
 */
function getProjectInfo() {
    try {
        if (!app || !app.project) {
            return '{"hasProject":false,"isSaved":false,"projectPath":"","projectName":""}';
        }

        var proj = app.project;
        var pPath = proj.path ? proj.path : "";
        var pName = proj.name ? proj.name : "";
        var isSaved = (pPath !== null && pPath !== "" && pPath.length > 0);

        return '{"hasProject":true,"isSaved":' + (isSaved ? 'true' : 'false') + 
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
 * Import file directly into the designated Bin
 */
function importFileToBin(filePath, binName) {
    try {
        if (!app || !app.project) {
            return '{"success":false,"error":"Tidak ada project Premiere Pro yang terbuka."}';
        }

        if (!filePath) {
            return '{"success":false,"error":"File path kosong."}';
        }

        // Clean path separators if on Mac/Windows
        var fileObj = new File(filePath);
        if (!fileObj.exists) {
            return '{"success":false,"error":"File fisik tidak ditemukan di: ' + escapeJSONString(filePath) + '"}';
        }

        var targetBin = getOrCreateBin(binName || "YT Downloads");
        var fileArray = [fileObj.fsName];
        
        // Count items in targetBin before import
        var beforeCount = targetBin && targetBin.children ? targetBin.children.numItems : 0;

        // app.project.importFiles(fileArray, suppressUI, targetBin, importAsNumberedStills)
        var importSuccess = app.project.importFiles(fileArray, true, targetBin, false);

        // Fallback: If import went to root instead of targetBin, move it into targetBin
        if (targetBin && targetBin !== app.project.rootItem) {
            var afterCount = targetBin.children ? targetBin.children.numItems : 0;
            if (afterCount === beforeCount) {
                // Check root items for recently imported item
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

        return '{"success":true,"message":"File berhasil di-import ke bin","binName":' + escapeJSONString(binName || "YT Downloads") + ',"filePath":' + escapeJSONString(fileObj.fsName) + '}';
    } catch (err) {
        return '{"success":false,"error":' + escapeJSONString(err.toString()) + '}';
    }
}
