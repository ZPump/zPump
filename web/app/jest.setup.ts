import '@testing-library/jest-dom/extend-expect';

global.navigator.clipboard = {
  writeText: jest.fn()
} as unknown as Clipboard;
