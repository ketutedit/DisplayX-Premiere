/**
 * hostscript.jsx
 * ExtendScript host script for DisplayX - YouTube In-App Player
 */

function escapeJSONString(str) {
    if (!str) return '""';
    return '"' + str.replace(/\\/g, '\\\\')
                    .replace(/"/g, '\\"')
                    .replace(/\n/g, '\\n')
                    .replace(/\r/g, '\\r')
                    .replace(/\t/g, '\\t') + '"';
}

function getProjectInfo() {
    try {
        if (!app || !app.project) {
            return '{"hasProject":false}';
        }
        var proj = app.project;
        var pPath = proj.path ? proj.path : "";
        var pName = proj.name ? proj.name : "";
        return '{"hasProject":true,"projectPath":' + escapeJSONString(pPath) + ',"projectName":' + escapeJSONString(pName) + '}';
    } catch (err) {
        return '{"hasProject":false,"error":' + escapeJSONString(err.toString()) + '}';
    }
}
