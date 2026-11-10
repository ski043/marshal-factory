import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

// Installs the runner as a launchd LaunchAgent: started at login, restarted when it exits, logging
// to ~/Library/Logs/marshal-factory/runner.log. On Linux it is the systemd user service
// marshal-factory-runner.service instead, logging to ~/.local/state/marshal-factory/runner.log.
// Re-running with nothing changed leaves it alone.
//   bun scripts/install-runner.ts [--uninstall]

export const LABEL = "com.marshal-factory.runner";
const root = join(import.meta.dirname, "..");
const plistPath = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
const logPath = join(homedir(), "Library/Logs/marshal-factory/runner.log");
const domain = `gui/${userInfo().uid}`;

const which = (bin: string) => execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim();
const launchctl = (...args: string[]) => execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: "pipe" });
const loaded = () => {
  try {
    launchctl("print", `${domain}/${LABEL}`);
    return true;
  } catch {
    return false;
  }
};

if (process.platform === "linux") {
  // Linux: a systemd user service instead of a LaunchAgent. Needs lingering (loginctl enable-linger) to run without a login.
  const unit = "marshal-factory-runner.service";
  const unitPath = join(homedir(), ".config/systemd/user", unit);
  const linuxLog = join(homedir(), ".local/state/marshal-factory/runner.log");
  const systemctl = (...args: string[]) => execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: "pipe" });
  if (process.argv.includes("--uninstall")) {
    try { systemctl("disable", "--now", unit); } catch {}
    console.log(`stopped   ${unit}; ${unitPath} left in place`);
    process.exit(0);
  }
  const bun = which("bun");
  const t3 = process.env.T3CODE_CLI_PATH ?? [join(homedir(), ".t3/bin/t3")].find(existsSync) ?? which("t3");
  const tools = ["bun", "git", "gh", "node", "claude", "modal"].flatMap((b) => { try { return [which(b)]; } catch { return []; } });
  const path = [...new Set([...tools.map(dirname), dirname(t3), "/usr/local/bin", "/usr/bin", "/bin"])].join(":");
  const service = `[Unit]
Description=marshal-factory runner
After=network-online.target

[Service]
ExecStart=${bun} ${join(root, "runner/index.ts")}
WorkingDirectory=${root}
Environment=PATH=${path}
Environment=HOME=${homedir()}
Environment=T3CODE_CLI_PATH=${t3}
Restart=always
RestartSec=10
StandardOutput=append:${linuxLog}
StandardError=append:${linuxLog}

[Install]
WantedBy=default.target
`;
  mkdirSync(dirname(unitPath), { recursive: true });
  mkdirSync(dirname(linuxLog), { recursive: true });
  const changed = !existsSync(unitPath) || readFileSync(unitPath, "utf8") !== service;
  if (changed) writeFileSync(unitPath, service);
  systemctl("daemon-reload");
  systemctl("enable", unit);
  systemctl(changed ? "restart" : "start", unit);
  console.log(`${changed ? "installed" : "unchanged"} ${unit}; log ${linuxLog}`);
  process.exit(0);
}

if (process.argv.includes("--uninstall")) {
  if (loaded()) launchctl("bootout", `${domain}/${LABEL}`);
  console.log(`unloaded  ${LABEL}; ${plistPath} left in place`);
  process.exit(0);
}

// launchd starts with a bare PATH, so carry the directories of every tool the runner calls.
const tools = ["bun", "git"].map(which);
// T3 exports its CLI path only to sessions it starts; the daemon gets it from here.
// T3 installs its launcher at ~/.t3/bin/t3 and puts it on the login shell's PATH; launchd has neither.
const t3 = process.env.T3CODE_CLI_PATH ?? [join(homedir(), ".t3/bin/t3")].find(existsSync) ?? which("t3");
const path = [...new Set([...tools.map(dirname), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${escape(tools[0]!)}</string><string>${escape(join(root, "runner/index.ts"))}</string></array>
  <key>WorkingDirectory</key><string>${escape(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escape(path)}</string>
    <key>HOME</key><string>${escape(homedir())}</string>
    <key>T3CODE_CLI_PATH</key><string>${escape(t3)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escape(logPath)}</string>
  <key>StandardErrorPath</key><string>${escape(logPath)}</string>
</dict>
</plist>
`;

mkdirSync(dirname(plistPath), { recursive: true });
mkdirSync(dirname(logPath), { recursive: true });
const changed = !existsSync(plistPath) || readFileSync(plistPath, "utf8") !== plist;
if (changed) writeFileSync(plistPath, plist);
if (changed && loaded()) {
  launchctl("bootout", `${domain}/${LABEL}`);
  // bootout returns before the old process is gone; bootstrap fails until it is.
  for (let i = 0; i < 50 && loaded(); i++) execFileSync("/bin/sleep", ["0.2"]);
}
const wasLoaded = loaded();
if (changed || !wasLoaded) launchctl("bootstrap", domain, plistPath);
console.log(`${changed ? "installed" : wasLoaded ? "unchanged" : "loaded"} ${LABEL}; log ${logPath}`);
