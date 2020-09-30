/*
 * Copyright (C) 2017-2019 UBports Foundation <info@ubports.com>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

const axios = require("axios");
const shell = require("electron").shell;
const sudo = require("sudo-prompt");
const FormData = require("form-data");
const os = require("os");
const fs = require("fs-extra");
const path = require("path");
const checksum = require("checksum");
const cp = require("child_process");
const psTree = require("ps-tree");
const util = require("util");
global.packageInfo = require("../package.json");

fs.ensureDir(getUbuntuTouchDir());

const platforms = {
  linux: "linux",
  darwin: "mac",
  win32: "win"
};

var log = {
  error: l => {
    global.logger.log("error", l);
  },
  warn: l => {
    global.logger.log("warn", l);
  },
  info: l => {
    global.logger.log("info", l);
  },
  debug: l => {
    global.logger.log("debug", l);
  }
};

const getSettingsString = () =>
  `%60${JSON.stringify(global.installProperties.settings || {})}%60`;

const getPackageString = () =>
  `%60${isSnap() ? "snap" : global.packageInfo.package || "source"}%60`;

const getDeviceString = () =>
  global.installProperties.device
    ? `%60${global.installProperties.device}%60`
    : "Not detected";

const getTargetOsString = () =>
  !util.isUndefined(global.installProperties.osIndex)
    ? global.installConfig.operating_systems[global.installProperties.osIndex]
        .name
    : "Not yet set";

const getDebugInfo = (reason, logurl) =>
  `*Generated for ${global.packageInfo.version}* %0D%0A
Device: ${getDeviceString()} %0D%0A
OS to install: ${getTargetOsString()} %0D%0A
Settings: ${getSettingsString()} %0D%0A
Package: ${getPackageString()} %0D%0A
Operating System: ${getOsString()} %0D%0A
NodeJS version: ${process.version} %0D%0A
Error log: ${logurl} %0D%0A%0D%0A
%60%60%60 %0D%0A
${reason} %0D%0A
%60%60%60 %0D%0A`;

function createBugReport(title, callback) {
  var options = {
    limit: 400,
    start: 0,
    order: "desc"
  };

  global.logger.query(options, function(err, results) {
    if (err) {
      throw err;
    }

    var errorLog = "";
    results.file.forEach(err => {
      errorLog += err.level + ": ";
      errorLog += err.message + "\n";
    });

    const form = new FormData();
    form.append("poster", "UBports Installer");
    form.append("syntax", "text");
    form.append("expiration", "year");
    form.append("content", `Title: ${title}\n\n${errorLog}`);

    axios
      .post("http://paste.ubuntu.com", form, { headers: form.getHeaders() })
      .then(r => `https://paste.ubuntu.com/${r.request.path}`)
      .then(logurl => callback(getDebugInfo(title, logurl)))
      .catch(() => callback(false));
  });
}

function sendBugReport(title) {
  createBugReport(title, body => {
    shell.openExternal(
      `https://github.com/ubports/ubports-installer/issues/new?title=${title}&body=${body}`
    );
  });
}

function getOsString() {
  let versionString = "";
  switch (process.platform) {
    case "linux":
      versionString = cp
        .execSync("lsb_release -ds")
        .toString()
        .trim();
      break;
    case "darwin":
      versionString =
        cp
          .execSync("sw_vers -productVersion")
          .toString()
          .trim() +
        cp
          .execSync("sw_vers -buildVersion")
          .toString()
          .trim();
      break;
    case "win32":
      versionString = cp
        .execSync("ver")
        .toString()
        .trim();
      break;
    default:
      break;
  }
  return ["%60", os.type(), versionString, os.release(), os.arch(), "%60"]
    .filter(i => i)
    .join(" ");
}

function getLatestInstallerVersion() {
  return axios
    .get(
      "https://api.github.com/repos/ubports/ubports-installer/releases/latest",
      {
        json: true,
        headers: { "User-Agent": "axios" }
      }
    )
    .then(r => r.data.tag_name)
    .catch(log.error);
}

function setUdevRules() {
  sudo.exec(
    "cp " +
      path.join(__dirname, "../build/10-ubports.rules") +
      " /etc/udev/rules.d/ && " +
      '(udevadm control --reload-rules || echo "") && ' +
      '(udevadm trigger || echo "") && ' +
      '(service udev restart || echo "")',
    {
      name: "UBports Installer",
      icns: path.join(__dirname, "../build/icons/icon.icns")
    },
    error => {
      if (error) log.warn("setting udev rules failed");
      else log.debug("udev rules set");
    }
  );
}

function getUpdateAvailable() {
  return new Promise((resolve, reject) => {
    getLatestInstallerVersion()
      .then(latestVersion => {
        if (latestVersion != global.packageInfo.version) resolve();
        else reject();
      })
      .catch(resolve);
  });
}

function getUbuntuTouchDir() {
  var osCacheDir;
  switch (process.platform) {
    case "linux":
      osCacheDir = path.join(process.env.HOME, ".cache");
      break;
    case "darwin":
      osCacheDir = path.join(process.env.HOME, "Library/Caches");
      break;
    case "win32":
      osCacheDir = process.env.APPDATA;
      break;
    default:
      throw Error("Unknown platform " + process.platform);
  }
  return path.join(osCacheDir, "ubports");
}

function cleanInstallerCache() {
  fs.emptyDir(getUbuntuTouchDir());
}

function die(e) {
  log.error(e);
  process.exit(-1);
}

let toolpath = global.packageInfo.package
  ? path.join(
      __dirname,
      "../../app.asar.unpacked/platform-tools",
      platforms[os.platform()]
    )
  : path.join(__dirname, "..", "platform-tools", platforms[os.platform()]);
let processes = [];
function execTool(tool, args, callback) {
  let pid = cp.exec(
    [path.join(toolpath, tool)].concat(args).join(" "),
    {
      maxBuffer: 1024 * 1024 * 2
    },
    (error, stdout, stderr) => {
      global.logger.log(
        "command",
        tool +
          ": " +
          JSON.stringify({
            args: args,
            error: error,
            stdout: stdout,
            stderr: stderr
          })
      );
      callback(error, stdout, stderr);
    }
  );
  processes.push(pid);
  pid.on("exit", () => {
    processes.splice(processes.indexOf(pid), 1);
  });
}

// Since child_process.exec spins up a shell on posix, simply killing the process itself will orphan its children, who then will be adopted by pid 1 and continue running as zombie processes until the end of time.
function killSubprocesses() {
  if (process.platform === "win32") {
    processes.forEach(child => child.kill());
  } else {
    processes.forEach(pid => {
      psTree(pid.pid, function(err, children) {
        cp.spawn("kill", ["-9"].concat(children.map(p => p.PID)));
      });
    });
  }
}

function isSnap() {
  return process.env.SNAP_NAME || false;
}

function errorToUser(error, errorLocation, restart, ignore) {
  var errorString =
    "Error: " + (errorLocation ? errorLocation : "Unknown") + ": " + error;
  utils.log.error(
    errorString + (error.stack ? "\nstack trace: " + error.stack : "")
  );
  global.mainEvent.emit("user:error", errorString, restart, ignore);
}

module.exports = {
  cleanInstallerCache: cleanInstallerCache,
  errorToUser: errorToUser,
  log: log,
  isSnap: isSnap,
  execTool: execTool,
  killSubprocesses: killSubprocesses,
  getUbuntuTouchDir: getUbuntuTouchDir,
  sendBugReport: sendBugReport,
  setUdevRules: setUdevRules,
  getUpdateAvailable: getUpdateAvailable,
  die: die,
  unpack: util.promisify(require("7zip-min").unpack)
};
