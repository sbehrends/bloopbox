import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Pin and board resolution for the GPIO driver (docs/hardware.md).
 *
 * The driver itself needs a Pi, but *which lines it claims* is decided at module load from
 * the environment — and that is what lets a partly wired board (fewer buttons, no lamps) run the
 * same code as the full device. This is the only part of
 * `gpioDriver.ts` that can be locked down without hardware, so it is worth locking.
 *
 * Every case re-imports the module because the constants are read once at load, which is
 * the same reason a config change on the device needs a restart.
 */

async function loadDriver(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import('../hal/gpioDriver.ts');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('pin lists', () => {
  it('defaults to the three documented buttons and three LED lines', async () => {
    const { BUTTON_PINS, LED_PINS, GPIO_PINS } = await loadDriver({
      BUTTON_PINS: undefined,
      LED_PINS: undefined,
    });

    expect(BUTTON_PINS).toEqual(['GPIO17', 'GPIO27', 'GPIO22']);
    expect(LED_PINS).toEqual(['GPIO23', 'GPIO24', 'GPIO25']);
    // The defaults stay the documented ones; the env only overrides them.
    expect(BUTTON_PINS).toEqual([...GPIO_PINS.buttons]);
    expect(LED_PINS).toEqual([...GPIO_PINS.leds]);
  });

  it('treats an empty value as no pins, so a board with no lamps claims no lines', async () => {
    const { LED_PINS } = await loadDriver({ LED_PINS: '' });

    expect(LED_PINS).toEqual([]);
  });

  it('accepts a single button, leaving channels 2 and 3 with no hardware', async () => {
    const { BUTTON_PINS } = await loadDriver({ BUTTON_PINS: 'GPIO17' });

    expect(BUTTON_PINS).toEqual(['GPIO17']);
  });

  it('tolerates spaces and a trailing comma', async () => {
    const { BUTTON_PINS } = await loadDriver({ BUTTON_PINS: ' GPIO17 , GPIO27 ,' });

    expect(BUTTON_PINS).toEqual(['GPIO17', 'GPIO27']);
  });

  it('refuses more pins than there are channels rather than dropping one silently', async () => {
    await expect(loadDriver({ LED_PINS: 'GPIO23,GPIO24,GPIO25,GPIO26' })).rejects.toThrow(
      /4 pins but the device has 3 channels/,
    );
  });
});

describe('capture rate', () => {
  it('is 16 kHz unless a codec needs otherwise', async () => {
    const { CAPTURE_FORMAT } = await loadDriver({ CAPTURE_RATE: undefined });

    expect(CAPTURE_FORMAT.rate).toBe(16_000);
  });

  it('takes the WM8960 HAT rate from the environment', async () => {
    const { CAPTURE_FORMAT } = await loadDriver({ CAPTURE_RATE: '48000' });

    expect(CAPTURE_FORMAT.rate).toBe(48_000);
  });

  it.each(['abc', '0', '-1', '44100.5'])(
    'refuses %s rather than handing arecord a bad rate',
    async (value) => {
      await expect(loadDriver({ CAPTURE_RATE: value })).rejects.toThrow(
        /must be a positive whole number of Hz/,
      );
    },
  );
});

describe('board resolution', () => {
  /**
   * Stands in for an opengpio board map. Those are classes, but what the driver needs is
   * only "a function carrying output and watch", which is what it checks for.
   */
  const fakeBoard = Object.assign(function board() {}, {
    output: () => {},
    watch: () => {},
  });

  it('defaults to the Zero 2 W map', async () => {
    const { PI_BOARD } = await loadDriver({ PI_BOARD: undefined });

    expect(PI_BOARD).toBe('RaspberryPi_Zero2W');
  });

  it('takes the board name from the environment', async () => {
    const { PI_BOARD } = await loadDriver({ PI_BOARD: 'RaspberryPi_3B' });

    expect(PI_BOARD).toBe('RaspberryPi_3B');
  });

  it('finds a board by name on the module', async () => {
    const { resolveBoard } = await loadDriver({});

    expect(resolveBoard({ Edge: {}, RaspberryPi_3B: fakeBoard }, 'RaspberryPi_3B')).toBe(fakeBoard);
  });

  it('names the boards that do exist when the requested one does not', async () => {
    const { resolveBoard } = await loadDriver({});

    expect(() =>
      resolveBoard({ Edge: {}, RaspberryPi_Zero2W: fakeBoard, RaspberryPi_4B: fakeBoard }, 'Nope'),
    ).toThrow(/Available: RaspberryPi_Zero2W, RaspberryPi_4B/);
  });
});
