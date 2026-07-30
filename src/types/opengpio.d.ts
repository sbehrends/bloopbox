/**
 * Minimal ambient declaration for `opengpio`.
 *
 * The package is an `optionalDependency` that only builds on Linux with libgpiod, so it is
 * absent on every dev machine and `tsc` cannot see its bundled types. This declares only
 * the surface `src/hal/gpioDriver.ts` actually uses, transcribed from opengpio@2.0.2's
 * own .d.ts files.
 *
 * Deliberately declares no `enum` (`erasableSyntaxOnly` forbids them) — the numeric
 * constants are declared as literal-typed values instead.
 */
declare module 'opengpio' {
  import type { EventEmitter } from 'node:events';

  /** A resolved chip/line pair. */
  export type Gpio = { readonly chip: number; readonly line: number };

  /** Which transitions a watcher reports. */
  export const Edge: {
    readonly Rising: 1;
    readonly Falling: -1;
    readonly Both: 0;
  };

  /** Internal pull resistor configuration. */
  export const Bias: {
    readonly Disabled: 3;
    readonly PullUp: 4;
    readonly PullDown: 5;
  };

  export type GpioInputOptions = {
    /**
     * NOTE: opengpio@2.0.2 transposes `bias` and `debounce` when calling into its native
     * binding, so neither option behaves as documented. `gpioDriver.ts` passes neither and
     * handles both concerns elsewhere. See docs/hardware-bringup.md.
     */
    debounce?: number;
    bias?: number;
  };

  /** Common base: cleanup plus event emission. */
  export class GpioDriver extends EventEmitter {
    get stopped(): boolean;
    /** Releases the line. Safe to call twice. */
    stop(): void;
  }

  export class Output extends GpioDriver {
    /** Drives the line; reads back the last value written, or null before any write. */
    get value(): boolean | null;
    set value(value: boolean);
  }

  export class Input extends GpioDriver {
    get value(): boolean;
  }

  /** Emits `change`, `rise` and `fall` with the new line value. */
  export class Watch extends GpioDriver {
    get value(): boolean;
  }

  /** Pin identifier: a resolved Gpio, a board pin number, or a BCM name like "GPIO17". */
  type PinIdentifier = Gpio | number | string;

  export class Device {
    static board: Record<number, Gpio>;
    static bcm: Record<string, Gpio>;
    static input(gpio: PinIdentifier, options?: Omit<GpioInputOptions, 'debounce'>): Input;
    static output(gpio: PinIdentifier, options?: Record<string, never>): Output;
    static watch(
      gpio: PinIdentifier,
      edge: (typeof Edge)[keyof typeof Edge],
      options?: GpioInputOptions,
    ): Watch;
  }

  /** Our board. Its `bcm` map is keyed by names such as "GPIO17". */
  export class RaspberryPi_Zero2W extends Device {}
}
