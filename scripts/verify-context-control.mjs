#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_TAB = "plugin-panel:context-window";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_URL = process.env.BB_URL ?? "http://127.0.0.1:38886";
const DEFAULT_EVIDENCE = join(REPO_ROOT, "verify-artifacts", "context-control");
const DEFAULT_TIMEOUT = 25_000;

const HELP = `Usage: node scripts/verify-context-control.mjs --thread <thread-id> [options]

Drives the installed plugin in a real BB thread. Checks that the context
control opens the panel, closes it on a second click, opens it again, and
shows the native summary on hover. Use an idle thread: the control is
disabled while a turn runs.

Options:
  --thread <id>       BB thread to drive. Required. Or set BB_THREAD_ID.
  --url <url>         BB app URL. Default ${DEFAULT_URL}.
  --port <port>       Marionette port. Default: a free port from 2828.
  --firefox <path>    Firefox binary. Default: firefox. Or set FIREFOX_BIN.
  --evidence <dir>    Evidence directory. Default: verify-artifacts/context-control.
  --timeout <ms>      Step timeout. Default: ${DEFAULT_TIMEOUT}.
  -h, --help          Show this help.

The plugin must be installed and running from this checkout. The script
starts its own headless Firefox with a temporary profile, then removes the
profile. It does not remove the evidence directory.`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      console.log(HELP);
      process.exit(0);
    }
    const key = arg.startsWith("--") ? arg.slice(2) : null;
    if (!key) throw new Error(`Unknown argument: ${arg}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${arg}`);
    args[key] = value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const threadId = args.thread ?? process.env.BB_THREAD_ID;
if (!threadId) {
  console.error(HELP);
  process.exit(2);
}

const bbUrl = args.url ?? DEFAULT_URL;
const firefox = args.firefox ?? process.env.FIREFOX_BIN ?? "firefox";
const evidenceDir = args.evidence ?? DEFAULT_EVIDENCE;
const timeout = Number(args.timeout ?? DEFAULT_TIMEOUT);
const threadUrl = new URL(`/threads/${encodeURIComponent(threadId)}`, bbUrl).toString();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readVersion() {
  return JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).version;
}

function installedPlugin() {
  const output = execFileSync("bb", ["plugin", "list"], { encoding: "utf8" });
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("context-window@"));
  if (!line) {
    throw new Error("context-window is not installed; run bb plugin install . --yes");
  }
  const installed = line.slice("context-window@".length).split(/\s+/)[0];
  if (!line.includes("running")) {
    throw new Error(`context-window@${installed} is not running`);
  }
  const expected = readVersion();
  if (installed !== expected) {
    throw new Error(
      `installed context-window@${installed} != repo ${expected}; run bb plugin install . --yes`,
    );
  }
  return installed;
}

function checkFirefox() {
  const result = spawnSync(firefox, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot run ${firefox}: ${result.error?.message ?? result.stderr}`);
  }
  return `${(result.stdout || result.stderr || "").trim()}`;
}

async function fetchOk(url) {
  const response = await fetch(url, { redirect: "follow" });
  return response.ok;
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function freePort() {
  for (let port = 2828; port <= 2839; port++) {
    if (await canListen(port)) return port;
  }
  throw new Error("No free Marionette port in 2828-2839");
}

class Marionette {
  #socket;
  #buffer = Buffer.alloc(0);
  #nextId = 1;
  #pending = new Map();

  constructor(port) {
    this.port = port;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: this.port });
      this.#socket = socket;
      socket.once("connect", resolve);
      socket.once("error", reject);
      socket.on("data", (chunk) => this.#onData(chunk));
      socket.on("close", () => {
        for (const pending of this.#pending.values()) {
          pending.reject(new Error("Marionette connection closed"));
        }
        this.#pending.clear();
      });
    });
  }

  #onData(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const colon = this.#buffer.indexOf(0x3a);
      if (colon === -1) return;
      const length = Number(this.#buffer.subarray(0, colon).toString("ascii"));
      if (!Number.isFinite(length)) throw new Error("Invalid Marionette frame");
      const start = colon + 1;
      if (this.#buffer.length < start + length) return;
      const frame = this.#buffer.subarray(start, start + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(start + length);
      this.#onFrame(frame);
    }
  }

  #onFrame(frame) {
    let message;
    try {
      message = JSON.parse(frame);
    } catch {
      return;
    }
    if (!Array.isArray(message)) return;
    const [, id, error, result] = message;
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (error) pending.reject(new Error(JSON.stringify(error)));
    else pending.resolve(result);
  }

  send(name, params = {}) {
    const id = this.#nextId++;
    const payload = JSON.stringify([0, id, name, params]);
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.write(`${Buffer.byteLength(payload, "utf8")}:${payload}`);
    });
  }

  async execute(script) {
    const result = await this.send("WebDriver:ExecuteScript", { script, args: [] });
    return result?.value;
  }

  async screenshot() {
    const result = await this.send("WebDriver:TakeScreenshot", {});
    return result?.value;
  }

  close() {
    this.#socket?.end();
  }
}

const PAGE_SCRIPT = `return (() => {
  const control = [...document.querySelectorAll("button[aria-label]")]
    .find((button) => /^Context window \\d+% used$/.test(button.getAttribute("aria-label") || ""));
  const controlBox = control ? control.getBoundingClientRect() : null;
  const controlVisible = Boolean(
    controlBox &&
      controlBox.width > 0 &&
      controlBox.height > 0 &&
      controlBox.right > 0 &&
      controlBox.left < innerWidth &&
      controlBox.bottom > 0 &&
      controlBox.top < innerHeight,
  );
  const controlEnabled = Boolean(
    control &&
      !control.disabled &&
      control.getAttribute("aria-disabled") !== "true",
  );
  const heading = [...document.querySelectorAll("h2")]
    .find((element) => element.textContent?.trim() === "Current context window");
  const headingBox = heading ? heading.getBoundingClientRect() : null;
  const thread = location.pathname.match(/\\/threads\\/([^/?#]+)/)?.[1];
  const state = thread
    ? Object.keys(localStorage)
        .filter((key) => key.startsWith("bb.thread.fixedPanelTabsState-" + thread + "-"))
        .map((key) => {
          try {
            const value = JSON.parse(localStorage.getItem(key));
            return {
              isOpen: value?.secondary?.isOpen === true,
              active: value?.secondary?.activeTabId ?? null,
            };
          } catch {
            return { isOpen: false, active: null };
          }
        })
    : [];
  const popover = document.querySelector('[class*="@container/context-window"]');
  const trigger = document.querySelector("[data-bb-context-window-trigger]");
  return {
    control: controlBox
      ? {
          label: control.getAttribute("aria-label"),
          x: controlBox.x + controlBox.width / 2,
          y: controlBox.y + controlBox.height / 2,
          visible: controlVisible,
          enabled: controlEnabled,
        }
      : null,
    heading: {
      present: Boolean(heading),
      onScreen: Boolean(
        headingBox &&
          headingBox.width > 0 &&
          headingBox.height > 0 &&
          headingBox.right > 0 &&
          headingBox.left < innerWidth &&
          headingBox.bottom > 0 &&
          headingBox.top < innerHeight,
      ),
    },
    state,
    trigger: Boolean(trigger),
    popover: popover
      ? {
          text: popover.innerText,
          hasFullBreakdown: [...popover.querySelectorAll("button")].some((button) =>
            button.textContent?.includes("Full breakdown"),
          ),
        }
      : null,
  };
})()`;

const settings = {
  user_pref: (name, value) => `user_pref("${name}", ${value});`,
};

async function startFirefox(port) {
  const profile = await mkdtemp(join(tmpdir(), "bb-context-verify-"));
  await writeFile(
    join(profile, "user.js"),
    [
      settings.user_pref("marionette.port", port),
      settings.user_pref("browser.shell.checkDefaultBrowser", false),
      settings.user_pref("browser.startup.page", 0),
      settings.user_pref("datareporting.policy.dataSubmissionEnabled", false),
      settings.user_pref("toolkit.telemetry.enabled", false),
      "",
    ].join("\n"),
  );
  const child = spawn(
    firefox,
    ["--headless", "--marionette", "--no-remote", "--profile", profile],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, MOZ_CRASHREPORTER: "0" },
    },
  );
  child.once("error", () => {});
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Firefox exited before Marionette was ready (code ${child.exitCode})`);
    }
    const ready = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ready) return { child, profile };
    await sleep(200);
  }
  await stopFirefox(child);
  await rm(profile, { recursive: true, force: true });
  throw new Error(`Firefox did not open Marionette on port ${port}`);
}

async function stopFirefox(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([once(child, "exit"), sleep(3000)]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const checks = [];
  const screenshots = [];
  let client = null;
  let firefoxProcess = null;
  let profile = null;
  let installed = null;
  let runError = null;

  const record = (name, ok, detail = "") => {
    checks.push({ name, status: ok ? "passed" : "failed", message: detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
    if (!ok) throw new Error(detail || name);
  };

  await mkdir(evidenceDir, { recursive: true });
  await rm(join(evidenceDir, "failure.png"), { force: true });

  try {
    installed = installedPlugin();
    const version = checkFirefox();
    if (!(await fetchOk(bbUrl))) throw new Error(`BB is not reachable at ${bbUrl}`);
    if (!(await fetchOk(threadUrl))) throw new Error(`Thread URL is not reachable: ${threadUrl}`);
    record("BB is reachable", true);
    record("plugin is installed and current", true, `context-window@${installed}`);
    record("Firefox is available", true, version);

    const port = args.port ? Number(args.port) : await freePort();
    if (!(await canListen(port))) {
      throw new Error(`Marionette port ${port} is not free`);
    }
    ({ child: firefoxProcess, profile } = await startFirefox(port));

    client = new Marionette(port);
    await client.connect();
    await client.send("WebDriver:NewSession", { capabilities: {} });
    await client.send("WebDriver:SetTimeouts", {
      implicit: 0,
      pageLoad: 120_000,
      script: 60_000,
    });
    await client.send("WebDriver:Navigate", { url: threadUrl });

    const readPage = async () => client.execute(PAGE_SCRIPT);
    const waitFor = async (label, predicate) => {
      const deadline = Date.now() + timeout;
      let lastError = null;
      while (Date.now() < deadline) {
        try {
          const value = await predicate();
          if (value) return value;
        } catch (error) {
          lastError = error;
        }
        await sleep(150);
      }
      throw new Error(
        `Timed out: ${label}${lastError ? `: ${lastError.message}` : ""}`,
      );
    };

    await waitFor("plugin ready", async () => {
      const page = await readPage();
      return page.trigger ? page : null;
    });

    const control = await waitFor("usable context control", async () => {
      const page = await readPage();
      return page.control?.visible && page.control.enabled ? page.control : null;
    });
    record("context control found", true, control.label);

    const clickAt = async (point) => {
      await client.send("WebDriver:PerformActions", {
        actions: [
          {
            type: "pointer",
            id: "mouse",
            parameters: { pointerType: "mouse" },
            actions: [
              {
                type: "pointerMove",
                duration: 80,
                origin: "viewport",
                x: Math.round(point.x),
                y: Math.round(point.y),
              },
              { type: "pointerDown", button: 0 },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      });
      await client.send("WebDriver:ReleaseActions", {});
    };

    const pluginOpen = (page) =>
      page.state.some(
        (state) => state.isOpen && state.active?.includes(PLUGIN_TAB),
      );
    const anyOpen = (page) => page.state.some((state) => state.isOpen);
    const usableControl = (page) =>
      page.control?.visible && page.control.enabled ? page.control : null;

    const openPanel = async () => {
      const deadline = Date.now() + timeout;
      let lastClick = 0;
      while (Date.now() < deadline) {
        const page = await readPage();
        if (pluginOpen(page) && page.heading.onScreen) return page;
        const point = usableControl(page);
        if (!anyOpen(page) && point && Date.now() - lastClick > 2000) {
          await clickAt(point);
          lastClick = Date.now();
        } else if (anyOpen(page) && !pluginOpen(page) && point) {
          await clickAt(point);
          lastClick = Date.now();
        }
        await sleep(300);
      }
      throw new Error("Panel did not open");
    };

    const closePanel = async () => {
      const deadline = Date.now() + timeout;
      let lastClick = 0;
      while (Date.now() < deadline) {
        const page = await readPage();
        if (!anyOpen(page) && !page.heading.onScreen) return page;
        const point = usableControl(page);
        if (anyOpen(page) && point && Date.now() - lastClick > 2000) {
          await clickAt(point);
          lastClick = Date.now();
        }
        await sleep(300);
      }
      throw new Error("Panel did not close");
    };

    await closePanel();
    record("panel starts closed", true);

    await openPanel();
    record("click opens the panel", true, "plugin tab active, heading on screen");
    const openShot = await client.screenshot();
    if (openShot) {
      const path = join(evidenceDir, "panel-open.png");
      await writeFile(path, Buffer.from(openShot, "base64"));
      screenshots.push(path);
    }

    await closePanel();
    record("click closes the panel", true, "heading off screen");

    await openPanel();
    record("click opens the panel again", true);

    const hoverPoint = usableControl(await readPage());
    if (!hoverPoint) throw new Error("Context control is not usable for the hover");
    await client.send("WebDriver:PerformActions", {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              duration: 150,
              origin: "viewport",
              x: Math.round(hoverPoint.x),
              y: Math.round(hoverPoint.y),
            },
          ],
        },
      ],
    });
    const summary = await waitFor("native summary", async () => {
      const page = await readPage();
      return page.popover;
    });
    record(
      "hover shows the native summary",
      summary.text.includes("% used") && !summary.hasFullBreakdown,
      summary.text.replace(/\s+/g, " ").trim().slice(0, 120),
    );
    const popoverShot = await client.screenshot();
    if (popoverShot) {
      const path = join(evidenceDir, "popover.png");
      await writeFile(path, Buffer.from(popoverShot, "base64"));
      screenshots.push(path);
    }

    await closePanel();
    record("final click closes the panel", true, "heading off screen");
  } catch (error) {
    runError = error;
    try {
      if (client) {
        const shot = await client.screenshot();
        if (shot) {
          const path = join(evidenceDir, "failure.png");
          await writeFile(path, Buffer.from(shot, "base64"));
          screenshots.push(path);
        }
      }
    } catch {
    }
    console.error(`FAIL ${error.message}`);
  } finally {
    try {
      client?.close();
    } catch {
    }
    await stopFirefox(firefoxProcess);
    if (profile) await rm(profile, { recursive: true, force: true });
    const finishedAt = new Date().toISOString();
    const result = {
      bbUrl,
      threadId,
      installedVersion: installed,
      marionettePort: client?.port ?? null,
      startedAt,
      finishedAt,
      checks,
      screenshots,
      error: runError?.message ?? null,
    };
    await writeFile(join(evidenceDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Evidence: ${evidenceDir}`);
    process.exitCode = runError ? 1 : 0;
  }
}

await main();
