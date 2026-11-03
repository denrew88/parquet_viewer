import assert from "node:assert/strict";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  discoverEnvironment,
  executableInvocation,
  isReleaseInvocation,
  planGeneratorEnvironment,
  resolveTarget,
  selectVisualStudioGenerator,
  targetEnvNames,
} from "./hdf5_release_build.mjs";

const host = "x86_64-pc-windows-msvc";
const arm = "aarch64-pc-windows-msvc";
const capabilities = {
  generators: [
    { name: "Visual Studio 16 2019" },
    { name: "Visual Studio 17 2022" },
    { name: "Ninja" },
  ],
};
const instances = [
  { installationVersion: "16.11.0", isComplete: true, isLaunchable: true },
  { installationVersion: "17.14.1", isComplete: true, isLaunchable: true },
  { installationVersion: "18.0.0", isComplete: true, isLaunchable: true },
];
const plan = (overrides = {}) =>
  planGeneratorEnvironment({
    command: "cargo",
    args: ["build", "--release"],
    env: { PATH: "original" },
    platform: "win32",
    host,
    capabilities,
    instances,
    ...overrides,
  });

test("release detection preserves debug/dev/test defaults and supports release aliases", () => {
  for (const [command, args] of [
    ["tauri", ["build"]],
    ["tauri.cmd", ["build", "--no-bundle"]],
    ["cargo", ["build", "--release"]],
    ["cargo", ["test", "-r"]],
    ["C:\\Rust\\cargo.exe", ["test", "--profile=release"]],
    ["cargo", ["build", "--profile", "release"]],
  ])
    assert.equal(isReleaseInvocation(command, args), true, `${command} ${args}`);
  for (const [command, args] of [
    ["tauri", ["build", "--debug"]],
    ["tauri", ["build", "-d"]],
    ["tauri", ["dev"]],
    ["cargo", ["build"]],
    ["cargo", ["test"]],
    ["cargo", ["test", "--", "--release"]],
    ["cargo", ["build", "--profile", "release-lto"]],
    ["node", ["--release"]],
  ])
    assert.equal(isReleaseInvocation(command, args), false, `${command} ${args}`);
});

test("explicit target aliases override Cargo env and host, excluding test arguments", () => {
  const env = { CARGO_BUILD_TARGET: arm };
  assert.equal(resolveTarget(["build", "--target", host], env, "linux"), host);
  assert.equal(resolveTarget(["build", "--target=" + host], env, "linux"), host);
  assert.equal(resolveTarget(["build", "-t", host], env, "linux"), host);
  assert.equal(resolveTarget(["build", "-t" + host], env, "linux"), host);
  assert.equal(resolveTarget(["test", "--", "--target", "ignored"], env, host), arm);
  assert.equal(resolveTarget([], {}, host), host);
});

test("selection intersects installed and CMake-supported generators instead of pinning VS17", () => {
  assert.equal(selectVisualStudioGenerator(capabilities, instances), "Visual Studio 17 2022");
  const withVS18 = { generators: [...capabilities.generators, { name: "Visual Studio 18 2026" }] };
  assert.equal(selectVisualStudioGenerator(withVS18, instances), "Visual Studio 18 2026");
  assert.equal(
    selectVisualStudioGenerator(capabilities, [{ installationVersion: "18.0" }]),
    undefined,
  );
  assert.equal(
    selectVisualStudioGenerator(capabilities, [{ installationVersion: "17.0", isComplete: false }]),
    undefined,
  );
  assert.equal(
    selectVisualStudioGenerator(capabilities, [
      { installationVersion: "17.0", isLaunchable: false },
    ]),
    undefined,
  );
});

test("MSVC release adds one target-specific variable without mutating caller env", () => {
  const env = { PATH: "original", CFLAGS: "/user-c", CXXFLAGS: "/user-cxx" };
  const result = plan({ env });
  assert.equal(result.changed, true);
  assert.deepEqual(result.env, {
    ...env,
    CMAKE_GENERATOR_x86_64_pc_windows_msvc: "Visual Studio 17 2022",
  });
  assert.deepEqual(env, { PATH: "original", CFLAGS: "/user-c", CXXFLAGS: "/user-cxx" });
});

test("all effective cmake override forms, including empty/case-insensitive values, are preserved", () => {
  for (const variable of targetEnvNames("CMAKE_GENERATOR", host, host)) {
    for (const value of ["Ninja", ""]) {
      const env = { [variable]: value, PATH: "original" };
      const result = plan({ env });
      assert.equal(result.changed, false, variable);
      assert.deepEqual(result.env, env);
    }
  }
  const mixed = { cmake_generator: "Ninja Multi-Config" };
  assert.deepEqual(plan({ env: mixed }).env, mixed);
  assert.equal(plan({ env: mixed }).changed, false);
});

test("cross MSVC target uses TARGET override and keeps unrelated target variables intact", () => {
  const env = {
    TARGET_CMAKE_GENERATOR: "Ninja",
    CMAKE_GENERATOR_x86_64_pc_windows_msvc: "Visual Studio 16 2019",
  };
  const overridden = plan({ args: ["build", "-r", "-t", arm], env });
  assert.equal(overridden.changed, false);
  assert.deepEqual(overridden.env, env);
  const local = plan({ env: { CMAKE_GENERATOR_aarch64_pc_windows_msvc: "Ninja" } });
  assert.equal(local.changed, true);
  assert.equal(local.env.CMAKE_GENERATOR_aarch64_pc_windows_msvc, "Ninja");
  assert.equal(local.env.CMAKE_GENERATOR_x86_64_pc_windows_msvc, "Visual Studio 17 2022");
});

test("non-Windows, GNU, other OS, and custom JSON targets remain unchanged", () => {
  const env = { PATH: "original" };
  for (const overrides of [
    { platform: "linux" },
    { platform: "darwin" },
    { args: ["build", "--release", "--target=x86_64-pc-windows-gnu"] },
    { args: ["build", "--release", "-t", "aarch64-apple-darwin"] },
    { args: ["build", "--release", "--target=custom-target.json"] },
    { host: "x86_64-unknown-linux-gnu" },
  ]) {
    const result = plan({ env, ...overrides });
    assert.equal(result.changed, false);
    assert.deepEqual(result.env, env);
  }
});

function mockDiscovery(env = {}) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "-vV") return { status: 0, stdout: `rustc 1.97.1\nhost: ${host}\n` };
    if (args[0] === "-E") return { status: 0, stdout: "\uFEFF" + JSON.stringify(capabilities) };
    if (args[0] === "-all") return { status: 0, stdout: JSON.stringify(instances) };
    throw new Error("Unexpected discovery command");
  };
  return { calls, options: { env, platform: "win32", run, exists: () => false } };
}

test("debug and non-MSVC paths avoid all external discovery", () => {
  for (const [command, args, extra] of [
    ["cargo", ["test"], {}],
    ["tauri", ["build", "-d"], {}],
    ["cargo", ["build", "--release", "--target=x86_64-pc-windows-gnu"], {}],
    ["tauri", ["build"], { platform: "linux" }],
  ]) {
    const mock = mockDiscovery({ PATH: "original" });
    const result = discoverEnvironment(command, args, { ...mock.options, ...extra });
    assert.equal(result.changed, false);
    assert.equal(mock.calls.length, 0);
  }
});

test("user generator overrides skip CMake and VS probing", () => {
  for (const env of [
    { CMAKE_GENERATOR: "Ninja" },
    { HOST_CMAKE_GENERATOR: "Ninja" },
    { CMAKE_GENERATOR_x86_64_pc_windows_msvc: "Ninja" },
  ]) {
    const mock = mockDiscovery(env);
    const result = discoverEnvironment("cargo", ["test", "--release"], mock.options);
    assert.equal(result.changed, false);
    assert.deepEqual(result.env, env);
    assert.ok(mock.calls.every((call) => call.args[0] === "-vV"));
  }
});

test("realistic discovery uses requested CMake binary and literal shell-free arguments", () => {
  const env = {
    PATH: "original",
    CMAKE_x86_64_pc_windows_msvc: "C:\\CMake tools\\cmake.exe",
    VSWHERE: "C:\\VS tools\\vswhere.exe",
  };
  const mock = mockDiscovery(env);
  const result = discoverEnvironment("tauri", ["build", "-t", host], mock.options);
  assert.equal(result.changed, true);
  assert.equal(mock.calls[1].command, env.CMAKE_x86_64_pc_windows_msvc);
  assert.equal(mock.calls[2].command, env.VSWHERE);
  assert.ok(mock.calls.every((call) => call.options.shell === false));
  assert.ok(mock.calls.every((call) => call.options.env === env));
  assert.deepEqual(mock.calls[2].args.slice(0, 4), ["-all", "-prerelease", "-products", "*"]);
});

test("failed discovery falls back explicitly without changing build env", () => {
  for (const run of [
    () => ({ status: 1, stdout: "" }),
    () => ({ error: new Error("missing compiler") }),
    () => ({ status: 0, stdout: "host line absent" }),
  ]) {
    const env = { PATH: "original" };
    const result = discoverEnvironment("cargo", ["build", "-r"], { env, platform: "win32", run });
    assert.equal(result.changed, false);
    assert.equal(result.discoveryFailed, true);
    assert.deepEqual(result.env, env);
  }
  const noneInstalled = plan({ instances: [] });
  assert.equal(noneInstalled.changed, false);
  assert.match(noneInstalled.reason, /No installed/u);
});

test("Windows tauri.cmd is launched with Node, never a shell, and arguments remain literal", () => {
  const args = ["build", "--features", "literal;$(not-a-command)", "--no-bundle"];
  const result = executableInvocation("tauri.cmd", args, {
    platform: "win32",
    root: "C:\\repo",
    exists: () => true,
  });
  assert.equal(result.executable, process.execPath);
  assert.deepEqual(result.args.slice(1), args);
  assert.match(result.args[0], /tauri\.js$/u);
  assert.throws(
    () => executableInvocation("tauri", args, { platform: "win32", exists: () => false }),
    /Local Tauri CLI is missing/u,
  );
  assert.deepEqual(executableInvocation("cargo", args, { platform: "win32" }), {
    executable: "cargo",
    args,
  });
});

test("CLI passthrough preserves stdout, metacharacter arguments and child exit status", () => {
  const wrapper = fileURLToPath(new URL("./hdf5_release_build.mjs", import.meta.url));
  const literal = "semicolon; ampersand& $(literal) spaces";
  const result = spawnSync(
    process.execPath,
    [
      wrapper,
      process.execPath,
      "-e",
      "process.stdout.write(process.argv[1]); process.exit(7)",
      literal,
    ],
    { encoding: "utf8", shell: false, windowsHide: true },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 7);
  assert.equal(result.stdout, literal);
  assert.equal(result.stderr, "");
});
