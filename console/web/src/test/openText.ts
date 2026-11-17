import { fireEvent } from "@testing-library/react";

/**
 * E948-S131 (vn_73e840cd): a card's text box is closed until Text is pressed. Tests that type into a card press Text first:
 * every closed Text button in `scope` (default the whole page) is pressed, so its box (words, paperclip, Send) is there.
 */
export function openText(scope: ParentNode = document): void {
  for (const b of [...scope.querySelectorAll<HTMLButtonElement>('[data-testid="card-feedback-text"][aria-expanded="false"]')]) fireEvent.click(b);
}
