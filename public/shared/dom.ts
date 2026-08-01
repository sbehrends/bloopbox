/**
 * Shared DOM builders for the pages that construct their controls in TypeScript.
 *
 * Layer 2 of the design system: `shared/base.css` decides what a card or a field *looks*
 * like, and these functions decide what it is *made of*, so a page never hand-assembles the
 * markup a class expects. They were private to the admin panel first; the simulator and the
 * brand kit need the same buttons and fields, hence the move.
 *
 * Nothing here touches fetch, Socket.io or any page's state — that is what makes it safe for
 * the setup portal to import if it ever wants to, without acquiring a dependency the captive
 * webview cannot be trusted with.
 */

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A labelled control, with an optional line of explanation underneath. */
export function field(labelText: string, input: HTMLElement, hint?: string): HTMLLabelElement {
  const label = element('label', 'field');
  label.append(element('span', 'field-label', labelText), input);
  if (hint) label.append(element('span', 'field-hint', hint));
  return label;
}

export function textInput(value: string, attrs: Partial<HTMLInputElement> = {}): HTMLInputElement {
  const input = element('input');
  input.type = 'text';
  input.value = value;
  Object.assign(input, attrs);
  return input;
}

export function numberInput(value: number, min: number, max: number): HTMLInputElement {
  const input = element('input');
  input.type = 'number';
  input.valueAsNumber = value;
  input.min = String(min);
  input.max = String(max);
  return input;
}

export function checkbox(checked: boolean): HTMLInputElement {
  const input = element('input');
  input.type = 'checkbox';
  input.checked = checked;
  return input;
}

/**
 * A checkbox with its label beside it, not above it.
 *
 * `field()` puts the label on its own line, which suits a text box and leaves a checkbox
 * stranded under a heading with nothing next to it. A tick belongs with its wording.
 */
export function checkboxField(labelText: string, input: HTMLInputElement): HTMLLabelElement {
  const label = element('label', 'checkbox');
  label.append(input, element('span', undefined, labelText));
  return label;
}

/** A titled panel. The title is an h2, which base.css sets in the section-label voice. */
export function card(title: string): HTMLElement {
  const section = element('section', 'card');
  section.append(element('h2', undefined, title));
  return section;
}

/**
 * A button that runs an async job and reports the outcome on itself.
 *
 * The label doubles as the progress indicator — "Saved" or "Failed" for a beat, then back —
 * because these pages have no room for a toast layer and no framework to render one.
 */
export function actionButton(
  label: string,
  run: () => Promise<void>,
  onError?: (error: unknown) => void,
): HTMLButtonElement {
  const button = element('button', 'primary', label);
  button.type = 'button';
  button.addEventListener('click', () => {
    void (async (): Promise<void> => {
      button.disabled = true;
      const original = button.textContent;
      try {
        await run();
        button.textContent = 'Saved';
      } catch (error: unknown) {
        button.textContent = 'Failed';
        onError?.(error);
      } finally {
        setTimeout(() => {
          button.textContent = original;
          button.disabled = false;
        }, 1200);
      }
    })();
  });
  return button;
}
