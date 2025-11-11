import '@testing-library/jest-dom';

global.navigator.clipboard = {
  writeText: jest.fn()
} as unknown as Clipboard;
