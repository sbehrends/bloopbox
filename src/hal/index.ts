import { MockHal } from './mockDriver.ts';
import { SimulatorHal, type SimulatorTransport } from './simulatorDriver.ts';
import type { Hal, HalOptions } from './types.ts';

/**
 * HAL factory (PRODUCT.md §4).
 *
 * The GPIO driver is loaded through a dynamic `import()` so `opengpio` — an
 * optionalDependency that only builds on Linux — is never resolved on a dev machine.
 * Importing this module must stay safe on macOS.
 */

export type HalKind = 'gpio' | 'simulator' | 'mock';

/** Which driver the environment asks for. `SIMULATOR_MODE=true` wins. */
export function selectHalKind(env: NodeJS.ProcessEnv = process.env): HalKind {
  if (env['HAL_DRIVER'] === 'mock') return 'mock';
  if (env['SIMULATOR_MODE'] === 'true') return 'simulator';
  return 'gpio';
}

export type CreateHalOptions = HalOptions & {
  readonly kind?: HalKind;
  /** Required for the simulator driver; ignored otherwise. */
  readonly transport?: SimulatorTransport;
};

/**
 * Builds a driver without initialising it — callers still `await hal.init()`, so startup
 * failures surface where they can be handled and reported on the LEDs.
 */
export async function createHal(options: CreateHalOptions): Promise<Hal> {
  const kind = options.kind ?? selectHalKind();

  switch (kind) {
    case 'mock':
      return new MockHal();

    case 'simulator': {
      if (!options.transport) {
        throw new Error('simulator HAL requires a transport');
      }
      return new SimulatorHal(options.transport, options);
    }

    case 'gpio': {
      // Dynamic: pulls in opengpio, which does not exist on macOS.
      const { GpioHal } = await import('./gpioDriver.ts');
      return new GpioHal(options);
    }

    default:
      // Unreachable for HalKind, but a bad HAL_DRIVER value should fail loudly.
      throw new Error(`unknown HAL driver: ${String(kind)}`);
  }
}

export { MockHal } from './mockDriver.ts';
export { SimulatorHal } from './simulatorDriver.ts';
export type { SimulatorTransport } from './simulatorDriver.ts';
export * from './types.ts';
