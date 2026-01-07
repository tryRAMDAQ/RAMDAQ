import os from "node:os";
import { execSync } from "node:child_process";
import { Worker } from "node:worker_threads";

/**
 * REAL hardware, really metered. This module detects the actual machine -
 * GPU (nvidia-smi if present, WMI otherwise), logical cores, RAM - and
 * executes rented jobs on worker threads that saturate the rented core
 * count with dense matrix math while holding a real RAM allocation.
 * Usage is measured, not simulated.
 */

export interface HardwareInfo {
  hostname: string;
  cpuModel: string;
  cores: number;
  ramGB: number;
  gpuName: string;
  hasNvidiaSmi: boolean;
}

export function detectHardware(): HardwareInfo {
  const cpus = os.cpus();
  let gpuName = "";
  let hasNvidiaSmi = false;
  try {
    gpuName = execSync("nvidia-smi --query-gpu=name --format=csv,noheader", { timeout: 4000 })
      .toString().trim().split("\n")[0];
    hasNvidiaSmi = true;
  } catch {
    try {
      // Windows fallback: WMI video controller name
      gpuName = execSync(
        'powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty Name)"',
        { timeout: 8000 }
      ).toString().trim();
    } catch {
      gpuName = "CPU-only";
    }
  }
  return {
    hostname: os.hostname(),
    cpuModel: cpus[0]?.model?.trim() ?? "unknown CPU",
    cores: cpus.length,
    ramGB: Math.round(os.totalmem() / 1024 ** 3),
    gpuName: gpuName || "unknown GPU",
    hasNvidiaSmi,
  };
}

/** Live NVIDIA telemetry (utilization %, VRAM MB) when nvidia-smi exists. */
export function sampleGpu(): { utilPct: number; memMB: number } | null {
  try {
    const out = execSync(
      "nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits",
      { timeout: 3000 }
    ).toString().trim().split("\n")[0];
    const [util, mem] = out.split(",").map((s) => parseInt(s.trim(), 10));
    return { utilPct: util, memMB: mem };
  } catch {
    return null;
  }
}

// Pure-math worker: fills matrices from a xorshift PRNG and multiplies them
// until the deadline, holding a touched RAM block the whole time. Sync loop =
// one fully saturated core per worker. No imports, so it runs via eval.
const WORKER_SRC = `
const { parentPort, workerData } = require("node:worker_threads");
const { durationMs, ramMB, seed } = workerData;
const started = Date.now();

// hold REAL memory: touch every page so it actually commits
const block = Buffer.allocUnsafe(ramMB * 1024 * 1024);
for (let i = 0; i < block.length; i += 4096) block[i] = i & 0xff;

let s = seed >>> 0;
const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
const N = 96;
const a = new Float64Array(N * N), b = new Float64Array(N * N), c = new Float64Array(N * N);
for (let i = 0; i < N * N; i++) { a[i] = rnd(); b[i] = rnd(); }

let ops = 0, checksum = 0;
while (Date.now() - started < durationMs) {
  for (let i = 0; i < N; i++) {
    for (let k = 0; k < N; k++) {
      const aik = a[i * N + k];
      for (let j = 0; j < N; j++) c[i * N + j] += aik * b[k * N + j];
    }
  }
  ops += 2 * N * N * N;
  checksum += c[(ops >>> 3) % (N * N)];
}
parentPort.postMessage({ cpuMs: Date.now() - started, gflops: ops / 1e9, checksum, ramMB });
`;

export interface BurnReport {
  threads: number;
  wallMs: number;
  cpuSecondsTotal: number;
  gflopsTotal: number;