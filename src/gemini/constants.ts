export const GEMINI_URL = 'https://gemini.google.com/app';

export const GEMINI_INPUT_SELECTORS = [
  'div.initial-input-area textarea',
  'rich-textarea .ql-editor',
  'rich-textarea.text-input-field_textarea div[role="textbox"]',
  '[contenteditable="true"][role="textbox"]',
];

export const GEMINI_SEND_BUTTON_SELECTORS = [
  '.send-button-container.visible button',
  '.send-button',
  'button[aria-label*="Send"]',
  'button[aria-label*="Ask Gemini"]',
];

