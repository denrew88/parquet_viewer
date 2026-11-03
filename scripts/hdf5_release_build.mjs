// cmake 0.1.58 replaces the default MSVC Release flags when it auto-selects a
// generator. An explicit generator retains CMake's optimized Release defaults.
// The current dependency graph uses this helper only for hdf5-metno-src.
// Do not set CFLAGS/CXXFLAGS or edit Cargo's source cache here.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function argumentValue(args, flag, shortFlag) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === flag || argument === shortFlag) return args[index + 1];
    if (argument.startsWith(`${flag}=`)) return argument.slice(flag.length + 1);
    if (shortFlag && argument.startsWith(shortFlag) && argument.length > shortFlag.length) {
      return argument.slice(shortFlag.length);
    }
  }
  return undefined;
}

function buildArguments(args) {
  const separator = args.indexOf("--");
  return separator === -1 ? args : args.slice(0, separator);
}

function commandName(command) {
  return command
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    .toLowerCase()
    .replace(/\.(?:exe|cmd)$/u, "");
}

export function isReleaseInvocation(command, args) {
  const options = buildArguments(args);
  if (commandName(command) === "tauri") {
    return options[0] === "build" && !options.includes("--debug") && !options.includes("-d");
  }
  if (commandName(command) === "cargo") {
    return (
      options.includes("--release") ||
      options.includes("-r") ||
      argumentValue(options, "--profile") === "release"
    );
  }
  return false;
}

function envValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key !== undefined && typeof env[key] === "string" ? env[key] : undefined;
}

export function resolveTarget(args, env, host) {
  return (
    argumentValue(buildArguments(args), "--target", "-t") ||
    envValue(env, "CARGO_BUILD_TARGET") ||
    host
  );
}

export function targetEnvNames(base, target, host) {
  return [
    `${base}_${target}`,
    `${base}_${target.replaceAll("-", "_")}`,
    `${host === target ? "HOST" : "TARGET"}_${base}`,
    base,
  ];
}

function firstTargetValue(env, base, target, host) {
  for (const name of targetEnvNames(base, target, host)) {
    const value = envValue(env, name);
    if (value !== undefined) return { name, value };
  }
  return undefined;
}

export function selectVisualStudioGenerator(capabilities, instances) {
  const installedMajors = new Set(
    instances
      .filter((instance) => instance.isComplete !== false && instance.isLaunchable !== false)
      .map((instance) => Number.parseInt(instance.installationVersion, 10))
      .filter(Number.isFinite),
  );
  return (capabilities.generators || [])
    .map(({ name }) => ({ name, major: Number(/^Visual Studio (\d+)\s/u.exec(name)?.[1]) }))
    .filter(({ major }) => installedMajors.has(major))
    .sort((a, b) => b.major - a.major)[0]?.name;
}

export function planGeneratorEnvironment({
  command,
  args,
  env,
  platform,
  host,
  capabilities,
  instances,
}) {
  const childEnv = { ...env };
  const target = resolveTarget(args, env, host);
  const result = { env: childEnv, changed: false, target, host };
  if (platform !== "win32" || !isReleaseInvocation(command, args)) {
    return { ...result, reason: "Not a Windows release build; environment unchanged." };
  }
  if (!target || !target.endsWith("-pc-windows-msvc")) {
    return { ...result, reason: "Not a Windows/MSVC target; environment unchanged." };
  }
  const explicit = firstTargetValue(env, "CMAKE_GENERATOR", target, host);
  if (explicit) {
    return { ...result, reason: `Preserving user generator from ${explicit.name}.` };
  }
  const generator = selectVisualStudioGenerator(capabilities, instances);
  if (!generator) {
    return {
      ...result,
      reason:
        "No installed Visual Studio generator supported by CMake was found; environment unchanged.",
    };
  }
  const variable = `CMAKE_GENERATOR_${target.replaceAll("-", "_")}`;
  childEnv[variable] = generator;
  return {
    ...result,
    env: childEnv,
    changed: true,
    variable,
    generator,
    reason: "Explicit MSVC generator preserves native CMake Release defaults.",
  };
}

function readJsonCommand(run, command, args, env) {
  const result = run(command, args, { env, encoding: "utf8", shell: false, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${path.basename(command)} discovery failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}`,
    );
  }
  return JSON.parse(result.stdout.replace(/^\uFEFF/u, "").trim());
}

export function discoverEnvironment(
  command,
  args,
  { env = process.env, platform = process.platform, run = spawnSync, exists = fs.existsSync } = {},
) {
  const unchanged = (reason) => ({ env: { ...env }, changed: false, reason });
  if (platform !== "win32" || !isReleaseInvocation(command, args)) {
    return unchanged("Not a Windows release build; environment unchanged.");
  }
  const declaredTarget = resolveTarget(args, env, undefined);
  if (declaredTarget && !declaredTarget.endsWith("-pc-windows-msvc")) {
    return unchanged("Not a Windows/MSVC target; environment unchanged.");
  }
  // A generic override applies to every target, including before host detection.
  if (envValue(env, "CMAKE_GENERATOR") !== undefined) {
    return unchanged("Preserving user CMAKE_GENERATOR.");
  }
  try {
    const rustc = envValue(env, "RUSTC") || "rustc";
    const detected = run(rustc, ["-vV"], {
      env,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
    if (detected.error || detected.status !== 0) throw new Error("Rust host discovery failed.");
    const host = /^host:\s*(\S+)/mu.exec(detected.stdout)?.[1];
    if (!host) throw new Error("Rust host triple was not reported.");
    const target = resolveTarget(args, env, host);
    if (!target.endsWith("-pc-windows-msvc"))
      return unchanged("Not a Windows/MSVC target; environment unchanged.");
    const explicit = firstTargetValue(env, "CMAKE_GENERATOR", target, host);
    if (explicit)
      return { ...unchanged(`Preserving user generator from ${explicit.name}.`), host, target };
    const cmake = firstTargetValue(env, "CMAKE", target, host)?.value || "cmake";
    const capabilities = readJsonCommand(run, cmake, ["-E", "capabilities"], env);
    const programFiles = envValue(env, "ProgramFiles(x86)") || envValue(env, "ProgramFiles");
    const usualVswhere =
      programFiles &&
      path.join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
    const vswhere =
      envValue(env, "VSWHERE") ||
      (usualVswhere && exists(usualVswhere) ? usualVswhere : "vswhere.exe");
    const instances = readJsonCommand(
      run,
      vswhere,
      [
        "-all",
        "-prerelease",
        "-products",
        "*",
        "-requires",
        "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
        "-format",
        "json",
        "-utf8",
      ],
      env,
    );
    return planGeneratorEnvironment({
      command,
      args,
      env,
      platform,
      host,
      capabilities,
      instances,
    });
  } catch (error) {
    return { ...unchanged(error.message), discoveryFailed: true };
  }
}

export function executableInvocation(
  command,
  args,
  { platform = process.platform, root = projectRoot, exists = fs.existsSync } = {},
) {
  // .cmd needs a shell on Windows. Run the project's Tauri JS entry with Node
  // instead, retaining shell:false and passing every CLI argument unchanged.
  if (platform === "win32" && /^(?:tauri|tauri\.cmd)$/iu.test(command)) {
    const entry = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
    if (!exists(entry))
      throw new Error("Local Tauri CLI is missing; install the project's npm dependencies first.");
    return { executable: process.execPath, args: [entry, ...args] };
  }
  return { executable: command, args };
}

export function main(argv = process.argv.slice(2)) {
  const printPlan = argv[0] === "--print-plan";
  if (printPlan) argv = argv.slice(1);
  const [command, ...args] = argv;
  if (!command) {
    console.error(
      "Usage: node scripts/hdf5_release_build.mjs [--print-plan] tauri build [args]\n       node scripts/hdf5_release_build.mjs [--print-plan] cargo build/test --release [args]",
    );
    return 2;
  }
  const plan = discoverEnvironment(command, args);
  if (printPlan) {
    const { env: ignored, ...details } = plan;
    console.log(JSON.stringify(details, null, 2));
    return 0;
  }
  if (plan.changed) console.error(`[hdf5-release] ${plan.variable}=${plan.generator}`);
  else if (plan.discoveryFailed || plan.reason.startsWith("No installed")) {
    console.error(
      `[hdf5-release] ${plan.reason} Native optimization was not selected automatically.`,
    );
  }
  try {
    const invocation = executableInvocation(command, args);
    const result = spawnSync(invocation.executable, invocation.args, {
      env: plan.env,
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    if (result.error) console.error(result.error.message);
    return result.status ?? (result.signal === "SIGINT" ? 130 : 1);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
