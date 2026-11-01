/**
 * CSInterface - v11.0.0
 * Minimal Adobe CEP Interface for communication between HTML/JS panel and ExtendScript
 */
function CSInterface() {}

CSInterface.prototype.getHostEnvironment = function() {
    var hostEnv = window.__adobe_cep__ ? window.__adobe_cep__.getHostEnvironment() : "{}";
    return JSON.parse(hostEnv);
};

CSInterface.prototype.closeExtension = function() {
    if (window.__adobe_cep__) {
        window.__adobe_cep__.closeExtension();
    }
};

CSInterface.prototype.getSystemPath = function(pathType) {
    if (window.__adobe_cep__) {
        return window.__adobe_cep__.getSystemPath(pathType);
    }
    return "";
};

CSInterface.prototype.evalScript = function(script, callback) {
    if (window.__adobe_cep__) {
        if (!callback) {
            callback = function() {};
        }
        window.__adobe_cep__.evalScript(script, callback);
    } else {
        console.warn("evalScript called outside Adobe CEP environment:", script);
        if (callback) callback('{"error":"Not running inside Adobe CEP"}');
    }
};

CSInterface.prototype.openURLInDefaultBrowser = function(url) {
    if (window.cep && window.cep.util) {
        window.cep.util.openURLInDefaultBrowser(url);
    } else if (window.__adobe_cep__) {
        window.__adobe_cep__.invokeSync("openURLInDefaultBrowser", url);
    } else {
        window.open(url, "_blank");
    }
};

SystemPath = {
    USER_DATA: "userData",
    COMMON_FILES: "commonFiles",
    MY_DOCUMENTS: "myDocuments",
    APPLICATION: "application",
    EXTENSION: "extension",
    HOST_APPLICATION: "hostApplication"
};
