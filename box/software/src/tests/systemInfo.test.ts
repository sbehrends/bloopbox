import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CpuUsageTracker,
  readModel,
  readStorage,
  readSystemInfo,
  readTemperatureC,
} from '../system/systemInfo.ts';

/**
 * The diagnostics readings.
 *
 * Every one of these is read off a file that does not exist on the machine this suite runs on,
 * which is the whole point: a null must be a null, never a throw and never a plausible-looking
 * zero. "0.0 °C" and "0 bytes free" are both alarms, and a dash is the truth.
 */

let workDir = '';

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'bloopbox-sysinfo-'));
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('readTemperatureC', () => {
  it('reads the kernel millidegrees', async () => {
    const path = join(workDir, 'temp');
    await writeFile(path, '48312\n', 'utf8');
    await expect(readTemperatureC(path)).resolves.toBe(48.3);
  });

  it('is null where there is no thermal zone, rather than throwing', async () => {
    // Every development machine on macOS takes this path.
    await expect(readTemperatureC(join(workDir, 'absent'))).resolves.toBeNull();
  });

  it('is null for a reading outside anything a board could be at', async () => {
    // A garbage read. Refusing to answer beats printing a figure that reads as a measurement.
    const path = join(workDir, 'temp');
    await writeFile(path, '900000\n', 'utf8');
    await expect(readTemperatureC(path)).resolves.toBeNull();
  });

  it('is null for a file that is not a number', async () => {
    const path = join(workDir, 'temp');
    await writeFile(path, 'warm\n', 'utf8');
    await expect(readTemperatureC(path)).resolves.toBeNull();
  });
});

describe('readModel', () => {
  it('strips the device tree NUL terminator', async () => {
    const path = join(workDir, 'model');
    await writeFile(path, 'Raspberry Pi Zero 2 W Rev 1.0\0', 'utf8');
    await expect(readModel(path)).resolves.toBe('Raspberry Pi Zero 2 W Rev 1.0');
  });

  it('is null off a device-tree platform', async () => {
    await expect(readModel(join(workDir, 'absent'))).resolves.toBeNull();
  });
});

describe('readStorage', () => {
  it('reports a real volume', async () => {
    const info = await readStorage({ label: 'Work', path: workDir });
    expect(info).not.toBeNull();
    expect(info?.label).toBe('Work');
    expect(info?.totalBytes).toBeGreaterThan(0);
    expect(info?.usedPercent).toBeGreaterThanOrEqual(0);
    expect(info?.usedPercent).toBeLessThanOrEqual(100);
  });

  it('is null for a path that is not there, rather than an empty disk', async () => {
    await expect(readStorage({ label: 'Gone', path: join(workDir, 'absent') })).resolves.toBeNull();
  });
});

describe('CpuUsageTracker', () => {
  it('is a rate between two readings, not an average since boot', () => {
    const tracker = new CpuUsageTracker({ busy: 1000, total: 10_000 });
    // 250 of the next 1000 ticks were busy — 25%, whatever happened before the window.
    expect(tracker.read({ busy: 1250, total: 11_000 })).toBe(25);
  });

  it('repeats its last answer when no time has passed, rather than dividing by zero', () => {
    const tracker = new CpuUsageTracker({ busy: 0, total: 0 });
    expect(tracker.read({ busy: 0, total: 0 })).toBeNull();
    expect(tracker.read({ busy: 50, total: 100 })).toBe(50);
    expect(tracker.read({ busy: 50, total: 100 })).toBe(50);
  });
});

describe('readSystemInfo', () => {
  it('answers with every field the panel renders, on a machine that is not a Pi', async () => {
    const info = await readSystemInfo({
      cpu: new CpuUsageTracker(),
      storage: [{ label: 'Work', path: workDir }],
      now: () => 1234,
    });

    expect(info.readAtMs).toBe(1234);
    expect(info.uptimeSeconds).toBeGreaterThan(0);
    expect(info.memory.totalBytes).toBeGreaterThan(0);
    expect(info.cpu.loadAverage).toHaveLength(3);
    expect(info.storage).toHaveLength(1);
    // The two that a laptop cannot answer. Present as keys, null as values.
    expect(info).toHaveProperty('temperatureC');
    expect(info.host).toHaveProperty('model');
  });

  it('drops a volume it cannot stat instead of reporting it as full', async () => {
    const info = await readSystemInfo({
      cpu: new CpuUsageTracker(),
      storage: [
        { label: 'Work', path: workDir },
        { label: 'Gone', path: join(workDir, 'absent') },
      ],
    });
    expect(info.storage.map((entry) => entry.label)).toEqual(['Work']);
  });
});
